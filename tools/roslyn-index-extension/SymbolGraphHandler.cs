using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Extensions;
using Microsoft.CodeAnalysis.FindSymbols;
using Microsoft.CodeAnalysis.Text;

namespace Codewise.RoslynExtension;

public sealed class SymbolGraphHandler
    : IExtensionWorkspaceMessageHandler<SymbolGraphRequest, SymbolGraphResponse>
{
    public const int ProtocolVersion = 2;

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
        var resolution = await ResolveSymbolsAsync(
            request,
            context.Solution,
            cancellationToken).ConfigureAwait(false);

        return new SymbolGraphResponse
        {
            ProtocolVersion = ProtocolVersion,
            Symbols = resolution.Symbols,
            UnresolvedOccurrenceIds = resolution.UnresolvedOccurrenceIds,
            SolutionProjectCount = context.Solution.ProjectIds.Count,
            SolutionDocumentCount = context.Solution.Projects.Sum(
                project => project.DocumentIds.Count),
            SymbolResolutionMilliseconds = stopwatch.ElapsedMilliseconds
        };
    }

    private static async Task<SymbolResolution> ResolveSymbolsAsync(
        SymbolGraphRequest request,
        Solution solution,
        CancellationToken cancellationToken)
    {
        var symbolBuilders = new Dictionary<ISymbol, SymbolBuilder>(
            SymbolEqualityComparer.Default);
        var unresolvedOccurrenceIds = new List<long>();
        var documentsByPath = solution.Projects
            .SelectMany(project => project.Documents)
            .Where(document => document.FilePath is not null)
            .GroupBy(
                document => Path.GetFullPath(document.FilePath!),
                PathComparer)
            .ToDictionary(
                group => group.Key,
                group => group.ToArray(),
                PathComparer);

        foreach (var requestedDocument in request.Documents)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (
                !documentsByPath.TryGetValue(
                    Path.GetFullPath(new Uri(requestedDocument.Uri).LocalPath),
                    out var documents)
                || documents.Length == 0
            )
            {
                unresolvedOccurrenceIds.AddRange(
                    requestedDocument.Occurrences.Select(occurrence => occurrence.Id));
                continue;
            }

            var document = documents[0];
            var text = await document.GetTextAsync(cancellationToken).ConfigureAwait(false);
            var semanticModel = await document.GetSemanticModelAsync(cancellationToken)
                .ConfigureAwait(false);
            if (semanticModel is null)
            {
                unresolvedOccurrenceIds.AddRange(
                    requestedDocument.Occurrences.Select(occurrence => occurrence.Id));
                continue;
            }

            foreach (var occurrence in requestedDocument.Occurrences)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (!TryGetPosition(text, occurrence, out var position))
                {
                    unresolvedOccurrenceIds.Add(occurrence.Id);
                    continue;
                }

                var symbol = await SymbolFinder.FindSymbolAtPositionAsync(
                    semanticModel,
                    position,
                    solution.Workspace,
                    cancellationToken).ConfigureAwait(false);
                if (symbol is null)
                {
                    unresolvedOccurrenceIds.Add(occurrence.Id);
                    continue;
                }

                symbol = NormalizeSymbol(symbol);
                if (!symbolBuilders.TryGetValue(symbol, out var builder))
                {
                    builder = new SymbolBuilder(symbol);
                    symbolBuilders.Add(symbol, builder);
                }
                builder.AddOccurrence(occurrence.Id, document.FilePath!, position);
            }
        }

        return new SymbolResolution(
            symbolBuilders.Values
                .Select(builder => builder.ToSymbol())
                .OrderBy(symbol => symbol.ProviderKey, StringComparer.Ordinal)
                .ToArray(),
            unresolvedOccurrenceIds.ToArray());
    }

    private static ISymbol NormalizeSymbol(ISymbol symbol)
    {
        if (symbol is IAliasSymbol alias)
            symbol = alias.Target;
        if (symbol is IMethodSymbol { ReducedFrom: not null } reducedMethod)
            symbol = reducedMethod.ReducedFrom;
        return symbol.OriginalDefinition;
    }

    private static bool TryGetPosition(
        SourceText text,
        SymbolGraphOccurrence occurrence,
        out int position)
    {
        if (
            occurrence.StartLine < 0
            || occurrence.StartLine >= text.Lines.Count
            || occurrence.StartCharacter < 0
            || occurrence.StartCharacter
                > text.Lines[occurrence.StartLine].End
                    - text.Lines[occurrence.StartLine].Start
        )
        {
            position = 0;
            return false;
        }

        position = text.Lines.GetPosition(
            new LinePosition(
                occurrence.StartLine,
                occurrence.StartCharacter));
        return true;
    }

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
        private readonly List<long> _occurrenceIds = [];
        private readonly HashSet<long> _definitionOccurrenceIds = [];
        private readonly BulkLocation[] _definitions;

        public SymbolBuilder(ISymbol symbol)
        {
            _symbol = symbol;
            _definitions = GetDefinitions(symbol);
            ProviderKey = CreateProviderKey(symbol, _definitions);
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

        public string ProviderKey { get; }

        public void AddOccurrence(long id, string documentPath, int position)
        {
            _occurrenceIds.Add(id);
            var fullPath = Path.GetFullPath(documentPath);
            if (_symbol.Locations.Any(location => (
                location.IsInSource
                && location.SourceTree?.FilePath is { } definitionPath
                && PathComparer.Equals(Path.GetFullPath(definitionPath), fullPath)
                && location.SourceSpan.Contains(position))))
            {
                _definitionOccurrenceIds.Add(id);
            }
        }

        public SymbolGraphSymbol ToSymbol()
            => new()
            {
                ProviderKey = ProviderKey,
                DisplayName = _symbol.ToDisplayString(),
                Occurrences = _occurrenceIds
                    .Select(id => new SymbolGraphEdge
                    {
                        OccurrenceId = id,
                        IsDefinition = _definitionOccurrenceIds.Contains(id)
                    })
                    .ToArray(),
                Definitions = _definitions
            };
    }

    private sealed class SymbolResolution
    {
        public SymbolResolution(
            SymbolGraphSymbol[] symbols,
            long[] unresolvedOccurrenceIds)
        {
            Symbols = symbols;
            UnresolvedOccurrenceIds = unresolvedOccurrenceIds;
        }

        public SymbolGraphSymbol[] Symbols { get; }
        public long[] UnresolvedOccurrenceIds { get; }
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
    public SymbolGraphDocument[] Documents { get; set; } = [];
}

public sealed class SymbolGraphDocument
{
    public string Uri { get; set; } = "";
    public SymbolGraphOccurrence[] Occurrences { get; set; } = [];
}

public sealed class SymbolGraphOccurrence
{
    public long Id { get; set; }
    public int StartLine { get; set; }
    public int StartCharacter { get; set; }
    public int EndLine { get; set; }
    public int EndCharacter { get; set; }
}

public sealed class SymbolGraphResponse
{
    public int ProtocolVersion { get; set; }
    public SymbolGraphSymbol[] Symbols { get; set; } = [];
    public long[] UnresolvedOccurrenceIds { get; set; } = [];
    public int SolutionProjectCount { get; set; }
    public int SolutionDocumentCount { get; set; }
    public long SymbolResolutionMilliseconds { get; set; }
}

public sealed class SymbolGraphSymbol
{
    public string ProviderKey { get; set; } = "";
    public string DisplayName { get; set; } = "";
    public SymbolGraphEdge[] Occurrences { get; set; } = [];
    public BulkLocation[] Definitions { get; set; } = [];
}

public sealed class SymbolGraphEdge
{
    public long OccurrenceId { get; set; }
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
