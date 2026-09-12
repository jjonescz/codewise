using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.LanguageService;

namespace Codewise.RoslynInternalAccess;

public static class TokenSemanticAccessor
{
    public static TokenSemanticInfo GetSemanticInfo(
        Document document,
        SemanticModel semanticModel,
        SyntaxToken token,
        CancellationToken cancellationToken)
    {
        var syntaxFacts = document.Project.Services
            .GetRequiredService<ISyntaxFactsService>();
        var semanticFacts = document.Project.Services
            .GetRequiredService<ISemanticFactsService>();
        var declaredSymbol = semanticFacts.GetDeclaredSymbol(
            semanticModel,
            token,
            cancellationToken);
        ISymbol? referencedSymbol = null;

        if (syntaxFacts.IsBindableToken(semanticModel, token))
        {
            var bindableParent = syntaxFacts.TryGetBindableParent(token);
            if (bindableParent is not null)
            {
                referencedSymbol = semanticModel.GetSymbolInfo(
                    bindableParent,
                    cancellationToken).Symbol;
            }
        }

        return new TokenSemanticInfo(declaredSymbol, referencedSymbol);
    }
}

public readonly struct TokenSemanticInfo(
    ISymbol? declaredSymbol,
    ISymbol? referencedSymbol)
{
    public ISymbol? DeclaredSymbol { get; } = declaredSymbol;
    public ISymbol? ReferencedSymbol { get; } = referencedSymbol;
}
