# Changelog

## Unreleased

- The runtime supports Minecraft 1.21.2 to 26.3 on Forge, NeoForge and Fabric. It compiles on every version of
  each loader from 1.21.1 to 26.3 (and on 1.20.1), checked by the new compile test `test-runtime/compile.mjs`.
  - 1.21.9 and later: the new particles of Minecraft (`SingleQuadParticle`).
  - NeoForge 1.21.4 and later: the bus of `@EventBusSubscriber` is found from the event, named reload listeners.
  - Names changed by Mojang or a loader are replaced at install (`Identifier` in 1.21.11, `getLightCoords` in 26.1,
    EventBus 7 on Forge 1.21.6, `ParticleProviderRegistry` on Fabric API 26.1).
- Minecraft 26.1 and later needs no mappings on Fabric (the game is not obfuscated any more).

## 0.1.0

First version.

- Visual editor for Sparkle particle systems (`assets/<namespace>/sparkle/*.json`), with a 3D preview, undo and redo,
  and JSON schema validation.
- System templates: Sparks, Beam, Fountain, Bounce, Ribbon, Empty.
- User parameters that the code of the mod can set on each play.
- Install and update of the Java runtime for Forge, NeoForge and Fabric (Minecraft 1.20 to 1.21.1), without
  silent overwrite and with backups.
- English and French.
