using System.Collections.Concurrent;
using System.Diagnostics;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Extensions;
using Microsoft.CodeAnalysis.FindSymbols;
using Microsoft.CodeAnalysis.Text;

namespace Codewise.RoslynExtension;

public sealed class BulkReferencesHandler
    : IExtensionWorkspaceMessageHandler<BulkReferencesRequest, BulkReferencesResponse>
{
    public const int ProtocolVersion = 1;

    public async Task<BulkReferencesResponse> ExecuteAsync(
        BulkReferencesRequest request,
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
        var symbolResolutionMilliseconds = stopwatch.ElapsedMilliseconds;

        stopwatch.Restart();
        var groups = await FindReferencesAsync(
            resolution.SymbolOccurrences,
            context.Solution,
            request.MaxConcurrency,
            cancellationToken).ConfigureAwait(false);

        return new BulkReferencesResponse
        {
            ProtocolVersion = ProtocolVersion,
            Groups = groups,
            UnresolvedOccurrenceIds = resolution.UnresolvedOccurrenceIds,
            SolutionProjectCount = context.Solution.ProjectIds.Count,
            SolutionDocumentCount = context.Solution.Projects.Sum(
                project => project.DocumentIds.Count),
            SymbolResolutionMilliseconds = symbolResolutionMilliseconds,
            ReferenceSearchMilliseconds = stopwatch.ElapsedMilliseconds
        };
    }

    private static async Task<SymbolResolution> ResolveSymbolsAsync(
        BulkReferencesRequest request,
        Solution solution,
        CancellationToken cancellationToken)
    {
        var symbolOccurrences = new Dictionary<ISymbol, List<long>>(
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
                if (
                    occurrence.Line < 0
                    || occurrence.Line >= text.Lines.Count
                    || occurrence.Character < 0
                    || occurrence.Character
                        > text.Lines[occurrence.Line].End
                            - text.Lines[occurrence.Line].Start
                )
                {
                    unresolvedOccurrenceIds.Add(occurrence.Id);
                    continue;
                }

                var position = text.Lines.GetPosition(
                    new LinePosition(occurrence.Line, occurrence.Character));
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

                if (!symbolOccurrences.TryGetValue(symbol, out var occurrenceIds))
                {
                    occurrenceIds = [];
                    symbolOccurrences.Add(symbol, occurrenceIds);
                }
                occurrenceIds.Add(occurrence.Id);
            }
        }

        return new SymbolResolution(
            symbolOccurrences.ToArray(),
            unresolvedOccurrenceIds.ToArray());
    }

    private static async Task<BulkReferenceGroup[]> FindReferencesAsync(
        KeyValuePair<ISymbol, List<long>>[] symbolOccurrences,
        Solution solution,
        int requestedConcurrency,
        CancellationToken cancellationToken)
    {
        var results = new ConcurrentBag<BulkReferenceGroup>();
        var nextIndex = -1;
        var concurrency = Math.Max(
            1,
            Math.Min(requestedConcurrency, symbolOccurrences.Length));
        var workers = Enumerable.Range(0, concurrency).Select(async _ =>
        {
            while (true)
            {
                var index = Interlocked.Increment(ref nextIndex);
                if (index >= symbolOccurrences.Length)
                    return;

                var entry = symbolOccurrences[index];
                var symbol = entry.Key;
                var occurrenceIds = entry.Value;
                try
                {
                    var referencedSymbols = await SymbolFinder.FindReferencesAsync(
                        symbol,
                        solution,
                        cancellationToken).ConfigureAwait(false);
                    results.Add(new BulkReferenceGroup
                    {
                        OccurrenceIds = occurrenceIds.ToArray(),
                        Locations = ToLocations(referencedSymbols)
                    });
                }
                catch (Exception exception) when (
                    exception is not OperationCanceledException)
                {
                    results.Add(new BulkReferenceGroup
                    {
                        OccurrenceIds = occurrenceIds.ToArray(),
                        Error = exception.ToString()
                    });
                }
            }
        });
        await Task.WhenAll(workers).ConfigureAwait(false);
        return results
            .OrderBy(group => group.OccurrenceIds[0])
            .ToArray();
    }

    private static BulkLocation[] ToLocations(
        IEnumerable<ReferencedSymbol> referencedSymbols)
    {
        var locations = new Dictionary<string, BulkLocation>(StringComparer.Ordinal);
        foreach (var referencedSymbol in referencedSymbols)
        {
            foreach (var definition in referencedSymbol.Definition.Locations)
                AddLocation(definition);
            foreach (var reference in referencedSymbol.Locations)
                AddLocation(reference.Location);
        }
        return locations.Values
            .OrderBy(location => location.Uri, StringComparer.Ordinal)
            .ThenBy(location => location.StartLine)
            .ThenBy(location => location.StartCharacter)
            .ThenBy(location => location.EndLine)
            .ThenBy(location => location.EndCharacter)
            .ToArray();

        void AddLocation(Location location)
        {
            if (!location.IsInSource || location.SourceTree?.FilePath is not { } path)
                return;
            var span = location.GetLineSpan().Span;
            var result = new BulkLocation
            {
                Uri = PathToUri(path),
                StartLine = span.Start.Line,
                StartCharacter = span.Start.Character,
                EndLine = span.End.Line,
                EndCharacter = span.End.Character
            };
            var key = $"{result.Uri}\0{result.StartLine}\0{result.StartCharacter}"
                + $"\0{result.EndLine}\0{result.EndCharacter}";
            if (!locations.ContainsKey(key))
                locations.Add(key, result);
        }
    }

    private static string PathToUri(string path)
        => new Uri(Path.GetFullPath(path)).AbsoluteUri;

    private static StringComparer PathComparer
        => Environment.OSVersion.Platform == PlatformID.Win32NT
            ? StringComparer.OrdinalIgnoreCase
            : StringComparer.Ordinal;

    private sealed class SymbolResolution
    {
        public SymbolResolution(
            KeyValuePair<ISymbol, List<long>>[] symbolOccurrences,
            long[] unresolvedOccurrenceIds)
        {
            SymbolOccurrences = symbolOccurrences;
            UnresolvedOccurrenceIds = unresolvedOccurrenceIds;
        }

        public KeyValuePair<ISymbol, List<long>>[] SymbolOccurrences { get; }
        public long[] UnresolvedOccurrenceIds { get; }
    }
}

public sealed class BulkReferencesRequest
{
    public int ProtocolVersion { get; set; }
    public int MaxConcurrency { get; set; }
    public BulkReferenceDocument[] Documents { get; set; } = [];
}

public sealed class BulkReferenceDocument
{
    public string Uri { get; set; } = "";
    public BulkReferenceOccurrence[] Occurrences { get; set; } = [];
}

public sealed class BulkReferenceOccurrence
{
    public long Id { get; set; }
    public int Line { get; set; }
    public int Character { get; set; }
}

public sealed class BulkReferencesResponse
{
    public int ProtocolVersion { get; set; }
    public BulkReferenceGroup[] Groups { get; set; } = [];
    public long[] UnresolvedOccurrenceIds { get; set; } = [];
    public int SolutionProjectCount { get; set; }
    public int SolutionDocumentCount { get; set; }
    public long SymbolResolutionMilliseconds { get; set; }
    public long ReferenceSearchMilliseconds { get; set; }
}

public sealed class BulkReferenceGroup
{
    public long[] OccurrenceIds { get; set; } = [];
    public BulkLocation[] Locations { get; set; } = [];
    public string? Error { get; set; }
}

public sealed class BulkLocation
{
    public string Uri { get; set; } = "";
    public int StartLine { get; set; }
    public int StartCharacter { get; set; }
    public int EndLine { get; set; }
    public int EndCharacter { get; set; }
}
