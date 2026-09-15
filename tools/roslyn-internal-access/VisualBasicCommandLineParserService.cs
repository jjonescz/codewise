using System.Composition;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Host;
using Microsoft.CodeAnalysis.Host.Mef;
using Microsoft.CodeAnalysis.VisualBasic;

namespace Codewise.RoslynInternalAccess;

[ExportLanguageService(
    typeof(ICommandLineParserService),
    LanguageNames.VisualBasic,
    ServiceLayer.Host), Shared]
public sealed class VisualBasicCommandLineParserService : ICommandLineParserService
{
    [ImportingConstructor]
    public VisualBasicCommandLineParserService()
    {
    }

    public CommandLineArguments Parse(
        IEnumerable<string> arguments,
        string? baseDirectory,
        bool isInteractive,
        string? sdkDirectory)
        => VisualBasicCommandLineParser.Default.Parse(
            arguments.Select(RestoreDefineQuoteEscapes),
            baseDirectory,
            sdkDirectory);

    private static string RestoreDefineQuoteEscapes(string argument)
    {
        if (
            OperatingSystem.IsWindows()
            || !(
                argument.StartsWith("/define:\"", StringComparison.OrdinalIgnoreCase)
                || argument.StartsWith("-define:\"", StringComparison.OrdinalIgnoreCase)
                || argument.StartsWith("/d:\"", StringComparison.OrdinalIgnoreCase)
                || argument.StartsWith("-d:\"", StringComparison.OrdinalIgnoreCase))
        )
        {
            return argument;
        }

        // MSBuild normalizes backslashes in Unix item specs, including the
        // escaped quotes in VbcCommandLineArgs. Only repair wrapped define arguments.
        return argument.Replace("/\"", "\\\"", StringComparison.Ordinal);
    }
}
