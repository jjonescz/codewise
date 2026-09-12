using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using Codewise.RoslynInternalAccess;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Extensions;

namespace Codewise.RoslynExtension;

public sealed class SymbolGraphHandler
    : IExtensionWorkspaceMessageHandler<SymbolGraphRequest, SymbolGraphResponse>
{
    public const int ProtocolVersion = 3;

    public async Task<SymbolGraphResponse> ExecuteAsync(
        SymbolGraphRequest request,
        ExtensionMessageContext context,
        CancellationToken cancellationToken)
    {
        if (request.ProtocolVersion != ProtocolVersion)
        {
            throw new InvalidOperationException(
                $"Unsupported Codewise protocol version {request.ProtocolVersion}.");
        }

        var stopwatch = Stopwatch.StartNew();
        var documentsByPath = context.Solution.Projects
            .SelectMany(project => project.Documents)
            .Where(document => document.FilePath is not null)
            .GroupBy(
                document => Path.GetFullPath(document.FilePath!),
                PathComparer)
            .ToDictionary(
                group => group.Key,
                group => group
                    .OrderBy(document => document.Project.FilePath, PathComparer)
                    .ThenBy(document => document.Project.Name, StringComparer.Ordinal)
                    .ToArray(),
                PathComparer);
        var symbolBuilders = new Dictionary<ISymbol, SymbolBuilder>(
            SymbolEqualityComparer.Default);
        var processedDocumentUris = new List<string>();
        var missingDocumentUris = new List<string>();
        var failures = new List<DocumentFailure>();
        long tokenCount = 0;
        long occurrenceCount = 0;

        foreach (var requestedDocument in request.Documents)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var uri = new Uri(requestedDocument.Uri);
            var path = Path.GetFullPath(uri.LocalPath);
            if (
                !documentsByPath.TryGetValue(path, out var documents)
                || documents.Length == 0
            )
            {
                missingDocumentUris.Add(requestedDocument.Uri);
                continue;
            }

            var document = documents[0];
            try
            {
                var documentSymbolBuilders =
                    new Dictionary<ISymbol, SymbolBuilder>(
                        SymbolEqualityComparer.Default);
                var root = await document.GetSyntaxRootAsync(cancellationToken)
                    .ConfigureAwait(false);
                var semanticModel = await document
                    .GetSemanticModelAsync(cancellationToken)
                    .ConfigureAwait(false);
                if (root is null || semanticModel is null)
                {
                    failures.Add(new DocumentFailure
                    {
                        Uri = requestedDocument.Uri,
                        Message = "Roslyn returned no syntax root or semantic model."
                    });
                    continue;
                }

                foreach (var token in root.DescendantTokens(descendIntoTrivia: true))
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    tokenCount++;
                    if (token.IsMissing || token.Span.IsEmpty)
                        continue;

                    var semanticInfo = TokenSemanticAccessor.GetSemanticInfo(
                        document,
                        semanticModel,
                        token,
                        cancellationToken);
                    var symbol =
                        semanticInfo.DeclaredSymbol ?? semanticInfo.ReferencedSymbol;
                    if (symbol is null || !IncludeSymbol(symbol))
                        continue;

                    symbol = NormalizeSymbol(symbol);
                    if (!documentSymbolBuilders.TryGetValue(
                        symbol,
                        out var builder))
                    {
                        builder = new SymbolBuilder(symbol);
                        documentSymbolBuilders.Add(symbol, builder);
                    }

                    builder.AddOccurrence(
                        requestedDocument.Uri,
                        token.GetLocation());
                    occurrenceCount++;
                }
                foreach (var (symbol, documentBuilder) in documentSymbolBuilders)
                {
                    if (!symbolBuilders.TryGetValue(symbol, out var builder))
                    {
                        symbolBuilders.Add(symbol, documentBuilder);
                    }
                    else
                    {
                        builder.MergeFrom(documentBuilder);
                    }
                }
                processedDocumentUris.Add(requestedDocument.Uri);
            }
            catch (Exception exception) when (
                exception is not OperationCanceledException)
            {
                failures.Add(new DocumentFailure
                {
                    Uri = requestedDocument.Uri,
                    Message = exception.ToString()
                });
            }
        }

        return new SymbolGraphResponse
        {
            ProtocolVersion = ProtocolVersion,
            Symbols = symbolBuilders.Values
                .Select(builder => builder.ToSymbol())
                .GroupBy(symbol => symbol.ProviderKey, StringComparer.Ordinal)
                .Select(MergeSymbols)
                .OrderBy(symbol => symbol.ProviderKey, StringComparer.Ordinal)
                .ToArray(),
            ProcessedDocumentUris = processedDocumentUris.ToArray(),
            MissingDocumentUris = missingDocumentUris.ToArray(),
            Failures = failures.ToArray(),
            SolutionProjectCount = context.Solution.ProjectIds.Count,
            SolutionDocumentCount = context.Solution.Projects.Sum(
                project => project.DocumentIds.Count),
            TokenCount = tokenCount,
            OccurrenceCount = occurrenceCount,
            SymbolResolutionMilliseconds = stopwatch.ElapsedMilliseconds
        };
    }

    private static bool IncludeSymbol(ISymbol symbol)
        => symbol.Kind is not (
            SymbolKind.ArrayType
            or SymbolKind.Discard
            or SymbolKind.ErrorType)
        && symbol is not IMethodSymbol
        {
            MethodKind: MethodKind.BuiltinOperator
        };

    private static ISymbol NormalizeSymbol(ISymbol symbol)
    {
        if (symbol is IAliasSymbol alias)
            symbol = alias.Target;
        if (symbol is IMethodSymbol { ReducedFrom: not null } reducedMethod)
            symbol = reducedMethod.ReducedFrom;
        return symbol.OriginalDefinition;
    }

    private static SymbolGraphSymbol MergeSymbols(
        IGrouping<string, SymbolGraphSymbol> symbols)
        => new()
        {
            ProviderKey = symbols.Key,
            DisplayName = symbols
                .Select(symbol => symbol.DisplayName)
                .FirstOrDefault(name => name.Length > 0) ?? "",
            Occurrences = symbols
                .SelectMany(symbol => symbol.Occurrences)
                .Distinct(SymbolOccurrenceComparer.Instance)
                .ToArray(),
            Definitions = symbols
                .SelectMany(symbol => symbol.Definitions)
                .Distinct(BulkLocationComparer.Instance)
                .ToArray()
        };

    private static BulkLocation[] GetDefinitions(ISymbol symbol)
        => symbol.Locations
            .Where(location => (
                location.IsInSource
                && location.SourceTree?.FilePath is not null))
            .Select(ToLocation)
            .Distinct(BulkLocationComparer.Instance)
            .OrderBy(location => location.Uri, StringComparer.Ordinal)
            .ThenBy(location => location.StartLine)
            .ThenBy(location => location.StartCharacter)
            .ThenBy(location => location.EndLine)
            .ThenBy(location => location.EndCharacter)
            .ToArray();

    private static BulkLocation ToLocation(Location location)
    {
        var span = location.GetLineSpan().Span;
        return new BulkLocation
        {
            Uri = PathToUri(location.SourceTree!.FilePath),
            StartLine = span.Start.Line,
            StartCharacter = span.Start.Character,
            EndLine = span.End.Line,
            EndCharacter = span.End.Character
        };
    }

    private static string PathToUri(string path)
        => new Uri(Path.GetFullPath(path)).AbsoluteUri;

    private static StringComparer PathComparer
        => Environment.OSVersion.Platform == PlatformID.Win32NT
            ? StringComparer.OrdinalIgnoreCase
            : StringComparer.Ordinal;

    private sealed class SymbolBuilder
    {
        private readonly ISymbol _symbol;
        private readonly List<SymbolOccurrence> _occurrences = [];
        private readonly BulkLocation[] _definitions;

        public SymbolBuilder(ISymbol symbol)
        {
            _symbol = symbol;
            _definitions = GetDefinitions(symbol);
            ProviderKey = CreateProviderKey(symbol, _definitions);
        }

        public string ProviderKey { get; }

        public void AddOccurrence(
            string documentUri,
            Location location)
        {
            var span = location.GetLineSpan().Span;
            var isDefinition = _symbol.Locations.Any(definition => (
                definition.IsInSource
                && definition.SourceTree == location.SourceTree
                && definition.SourceSpan.IntersectsWith(location.SourceSpan)));
            _occurrences.Add(new SymbolOccurrence
            {
                Uri = documentUri,
                StartLine = span.Start.Line,
                StartCharacter = span.Start.Character,
                EndLine = span.End.Line,
                EndCharacter = span.End.Character,
                IsDefinition = isDefinition
            });
        }

        public SymbolGraphSymbol ToSymbol()
            => new()
            {
                ProviderKey = ProviderKey,
                DisplayName = _symbol.ToDisplayString(),
                Occurrences = _occurrences
                    .Distinct(SymbolOccurrenceComparer.Instance)
                    .ToArray(),
                Definitions = _definitions
            };

        public void MergeFrom(SymbolBuilder other)
            => _occurrences.AddRange(other._occurrences);
    }

    private static string CreateProviderKey(
        ISymbol symbol,
        BulkLocation[] definitions)
    {
        var identity = new StringBuilder()
            .Append(symbol.ContainingAssembly?.Identity.ToString() ?? "")
            .Append('\0')
            .Append(symbol.GetDocumentationCommentId() ?? "")
            .Append('\0')
            .Append(symbol.Kind)
            .Append('\0')
            .Append(symbol.MetadataName)
            .Append('\0')
            .Append(symbol.ContainingSymbol?.GetDocumentationCommentId() ?? "")
            .Append('\0')
            .Append(symbol.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat));
        foreach (var definition in definitions)
        {
            identity
                .Append('\0')
                .Append(definition.Uri)
                .Append(':')
                .Append(definition.StartLine)
                .Append(':')
                .Append(definition.StartCharacter)
                .Append(':')
                .Append(definition.EndLine)
                .Append(':')
                .Append(definition.EndCharacter);
        }
        using var sha256 = SHA256.Create();
        var bytes = sha256.ComputeHash(
            Encoding.UTF8.GetBytes(identity.ToString()));
        var result = new StringBuilder(bytes.Length * 2);
        foreach (var value in bytes)
            result.Append(value.ToString("x2"));
        return result.ToString();
    }

    private sealed class SymbolOccurrenceComparer
        : IEqualityComparer<SymbolOccurrence>
    {
        public static readonly SymbolOccurrenceComparer Instance = new();

        public bool Equals(SymbolOccurrence? left, SymbolOccurrence? right)
            => left is not null
                && right is not null
                && left.Uri == right.Uri
                && left.StartLine == right.StartLine
                && left.StartCharacter == right.StartCharacter
                && left.EndLine == right.EndLine
                && left.EndCharacter == right.EndCharacter
                && left.IsDefinition == right.IsDefinition;

        public int GetHashCode(SymbolOccurrence occurrence)
        {
            unchecked
            {
                var hash = StringComparer.Ordinal.GetHashCode(occurrence.Uri);
                hash = hash * 31 + occurrence.StartLine;
                hash = hash * 31 + occurrence.StartCharacter;
                hash = hash * 31 + occurrence.EndLine;
                hash = hash * 31 + occurrence.EndCharacter;
                return hash * 31 + (occurrence.IsDefinition ? 1 : 0);
            }
        }
    }

    private sealed class BulkLocationComparer : IEqualityComparer<BulkLocation>
    {
        public static readonly BulkLocationComparer Instance = new();

        public bool Equals(BulkLocation? left, BulkLocation? right)
            => left is not null
                && right is not null
                && left.Uri == right.Uri
                && left.StartLine == right.StartLine
                && left.StartCharacter == right.StartCharacter
                && left.EndLine == right.EndLine
                && left.EndCharacter == right.EndCharacter;

        public int GetHashCode(BulkLocation location)
        {
            unchecked
            {
                var hash = StringComparer.Ordinal.GetHashCode(location.Uri);
                hash = hash * 31 + location.StartLine;
                hash = hash * 31 + location.StartCharacter;
                hash = hash * 31 + location.EndLine;
                return hash * 31 + location.EndCharacter;
            }
        }
    }
}

public sealed class SymbolGraphRequest
{
    public int ProtocolVersion { get; set; }
    public RequestedDocument[] Documents { get; set; } = [];
}

public sealed class RequestedDocument
{
    public string Uri { get; set; } = "";
}

public sealed class SymbolGraphResponse
{
    public int ProtocolVersion { get; set; }
    public SymbolGraphSymbol[] Symbols { get; set; } = [];
    public string[] ProcessedDocumentUris { get; set; } = [];
    public string[] MissingDocumentUris { get; set; } = [];
    public DocumentFailure[] Failures { get; set; } = [];
    public int SolutionProjectCount { get; set; }
    public int SolutionDocumentCount { get; set; }
    public long TokenCount { get; set; }
    public long OccurrenceCount { get; set; }
    public long SymbolResolutionMilliseconds { get; set; }
}

public sealed class SymbolGraphSymbol
{
    public string ProviderKey { get; set; } = "";
    public string DisplayName { get; set; } = "";
    public SymbolOccurrence[] Occurrences { get; set; } = [];
    public BulkLocation[] Definitions { get; set; } = [];
}

public sealed class SymbolOccurrence
{
    public string Uri { get; set; } = "";
    public int StartLine { get; set; }
    public int StartCharacter { get; set; }
    public int EndLine { get; set; }
    public int EndCharacter { get; set; }
    public bool IsDefinition { get; set; }
}

public sealed class BulkLocation
{
    public string Uri { get; set; } = "";
    public int StartLine { get; set; }
    public int StartCharacter { get; set; }
    public int EndLine { get; set; }
    public int EndCharacter { get; set; }
}

public sealed class DocumentFailure
{
    public string Uri { get; set; } = "";
    public string Message { get; set; } = "";
}
