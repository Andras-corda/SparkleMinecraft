# Plugin IntelliJ IDEA

Le plugin Sparkle pour IntelliJ IDEA (2024.3 et plus) : le même éditeur de systèmes de particules que l'extension
VS Code, et le même runtime Java pour **Forge, NeoForge et Fabric**.

## Ce que fait le plugin

- **Fichier > Nouveau > Nouveau système de particules** (ou **Outils > Sparkle**) : choisir un modèle (Étincelles,
  Rayon, Fontaine, Rebond, Ruban, Vide) et un nom. Le fichier est créé dans
  `src/main/resources/assets/<mod id>/sparkle/<nom>.json`. Un fichier existant n'est jamais écrasé.
- **Éditeur** : tout fichier `assets/<namespace>/sparkle/*.json` s'ouvre dans l'éditeur Sparkle (émetteurs, modules,
  paramètres utilisateur, aperçu 3D). Les boutons en haut à droite passent du texte JSON à l'éditeur, ou montrent les
  deux côte à côte. Le JSON a la complétion et la validation par le schéma.
  - Chaque modification passe par le document d'IntelliJ : **Ctrl+Z / Ctrl+Y**, **Ctrl+S**, l'historique local et Git
    fonctionnent comme pour n'importe quel fichier.
  - Les couleurs suivent le thème de l'IDE ; les textes suivent sa langue (anglais ou français).
- **Outils > Sparkle > Installer ou mettre à jour le runtime dans le mod** : mêmes règles que dans VS Code (détection
  du loader, de la version, du mod id et du package, aucun fichier modifié à la main remplacé sans question, copies
  dans `.sparkle/backup/`). Le fichier `.sparkle/runtime.json` est le même : un runtime installé depuis VS Code se met
  à jour depuis IntelliJ, et l'inverse.
- **Copier le code qui joue le système** : clic droit sur le fichier ou sur son onglet.

## Comment c'est fait

Le plugin ne recopie pas l'extension VS Code : il la **compile** au build.

| Partie | Source |
| --- | --- |
| Éditeur (interface web) | `vscode/src/webview`, affiché dans un navigateur JCEF. Un petit pont remplace `acquireVsCodeApi()` et donne les couleurs du thème d'IntelliJ sous les noms de VS Code. |
| Textes français | `vscode/l10n/bundle.l10n.fr.json` et `vscode/package.nls.fr.json` |
| Modèles de systèmes | `vscode/src/shared/templates.ts`, exportés en JSON par `web/export.ts` |
| Runtime Java | `vscode/runtime` |
| Schéma JSON | `vscode/schemas/sparkle-system.schema.json` |
| Détection du projet, installation | réécrites en Kotlin (`src/main/kotlin/.../install`), avec les mêmes règles que `vscode/src/shared/project.ts` et `install.ts` |

Toute modification de l'éditeur, des modules ou du runtime dans `vscode/` arrive donc dans IntelliJ au prochain build.

## Développement

Il faut **Node** et un `npm install` dans `../vscode` (la tâche `buildWeb` utilise son esbuild), et un JDK 21 (celui
d'IntelliJ convient).

```bash
./gradlew buildPlugin     # build/distributions/sparkle-intellij-<version>.zip
./gradlew test            # tests de la détection, de l'installation et de fabric.mod.json
./gradlew runIde          # un IntelliJ de test avec le plugin
```

- Par défaut, Gradle télécharge IntelliJ IDEA Community 2024.3 pour compiler. Pour utiliser un IntelliJ déjà installé :
  `-PlocalIde="C:/Program Files/JetBrains/IntelliJ IDEA 2025.2.3"`.
- Ouvrir un projet de mod dans l'IntelliJ de test : `-PrunArgs="<dossier du projet>|<fichier à ouvrir>"`.
- Installer le `.zip` dans son IntelliJ : **Settings > Plugins > ⚙ > Install Plugin from Disk...**
- Publier sur le JetBrains Marketplace : `./gradlew publishPlugin` avec le jeton dans `JETBRAINS_MARKETPLACE_TOKEN`
  (la toute première version s'envoie à la main sur https://plugins.jetbrains.com).

## Limites connues

- Mêmes limites que l'extension VS Code : le runtime n'a **pas encore été essayé en jeu**.
- JCEF est nécessaire (présent dans IntelliJ par défaut). Sans JCEF, le fichier s'ouvre en texte seulement.
- Compilé contre IntelliJ IDEA Community 2024.3.6 et déclaré compatible avec 2024.3.6 et 2025.2.3 par le Plugin
  Verifier de JetBrains (`./gradlew verifyPlugin`). L'éditeur n'a été ouvert que dans IntelliJ 2025.2.
