package com.mineengine.sparkle.install

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.google.gson.JsonPrimitive
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.invariantSeparatorsPathString
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText

/*
 * Finds what the runtime of Sparkle needs in a mod project: the loader, the version of Minecraft, the mod id, the
 * package of the mod and, on Fabric, the mappings. Same rules as vscode/src/shared/project.ts.
 */

enum class Loader(val id: String, val title: String) {
    FORGE("forge", "Forge"),
    NEOFORGE("neoforge", "NeoForge"),
    FABRIC("fabric", "Fabric"),
}

enum class Mappings { MOJANG, YARN, UNKNOWN }

/** A message for the user, in English with {0}... (translated by L10n). */
data class Message(val text: String, val args: List<String> = emptyList()) {
    constructor(text: String, vararg args: String) : this(text, args.toList())
}

/** Reads the files of the project folder (paths relative to it, with "/"). */
interface ProjectFiles {
    fun read(path: String): String?

    /** Java files of src/main/java (relative paths). */
    fun javaFiles(): List<String>
}

class FolderFiles(private val root: Path) : ProjectFiles {
    override fun read(path: String): String? {
        val file = root.resolve(path)
        return if (file.isRegularFile()) file.readText() else null
    }

    override fun javaFiles(): List<String> {
        val java = root.resolve("src/main/java")
        if (!Files.isDirectory(java)) {
            return emptyList()
        }

        return Files.walk(java).use { files ->
            files.filter { it.toString().endsWith(".java") }.limit(5000).map { root.relativize(it).invariantSeparatorsPathString }.toList()
        }
    }
}

data class ModProject(
    val loader: Loader?,
    val minecraft: String?,
    val modId: String?,
    /** Package of the main class of the mod ("com.example.mymod"). */
    val modPackage: String?,
    val mappings: Mappings,
    /** Fabric: Fabric API is in the dependencies (the runtime needs it). */
    val fabricApi: Boolean,
    val problems: List<Message>,
)

/** What is installed for a project: its loader adapter, its variant, and how sure it is to work. */
data class Support(
    val supported: Boolean,
    val tested: Boolean,
    val adapter: Loader? = null,
    /** "1.20" (Minecraft 1.20 to 1.20.4) or "1.21" (1.20.5 and later). */
    val variant: String? = null,
    /** Minecraft 1.21.9 and later: the particles of one quad are SingleQuadParticle (folder mc1.21.9). */
    val quadParticles: Boolean = false,
    /** Folders of the loader adapter for its newer versions, copied after it (neoforge-1.21.4). */
    val adapterUpdates: List<String> = emptyList(),
    /** Names of the game changed by Mojang, replaced in the files of the runtime when they are installed. */
    val renames: List<Rename> = emptyList(),
    val problems: List<Message>,
)

/** A name of the game (or of a loader, when loader is given) that changed: the runtime is written with the old one. */
data class Rename(val since: List<Int>, val from: String, val to: String, val loader: Loader? = null)

object ProjectDetection {
    private const val RESOURCES = "src/main/resources"
    private const val TEMPLATES = "src/main/templates"

    /**
     * The versions the runtime was compiled on by vscode/test-runtime/compile.mjs: every release of Minecraft of the
     * loader from the first to the second version. Same list as TESTED of project.ts.
     */
    val TESTED = listOf(
        Triple(Loader.FORGE, "1.20.1", "1.20.1"),
        Triple(Loader.FORGE, "1.21.1", "26.3"),
        Triple(Loader.NEOFORGE, "1.20.6", "1.20.6"),
        Triple(Loader.NEOFORGE, "1.21.1", "26.3"),
        Triple(Loader.FABRIC, "1.20.1", "1.20.1"),
        Triple(Loader.FABRIC, "1.20.4", "1.20.4"),
        Triple(Loader.FABRIC, "1.21.1", "26.3"),
    )

    /** The last version of Minecraft the runtime was compiled on. */
    const val LATEST_TESTED = "26.3"

    fun isTested(loader: Loader, version: List<Int>): Boolean = TESTED.any { (l, from, to) ->
        l == loader && compareVersions(version, parseVersion(from)!!) >= 0 && compareVersions(version, parseVersion(to)!!) <= 0
    }

    /** Same list as RENAMES of project.ts. */
    val RENAMES = listOf(
        Rename(listOf(1, 21, 6), "net.minecraftforge.eventbus.api.SubscribeEvent", "net.minecraftforge.eventbus.api.listener.SubscribeEvent", Loader.FORGE),
        Rename(listOf(1, 21, 11), "ResourceLocation", "Identifier"),
        Rename(listOf(26, 1, 0), "getLightColor", "getLightCoords"),
        Rename(listOf(26, 1, 0), "ParticleFactoryRegistry", "ParticleProviderRegistry", Loader.FABRIC),
    )

    /** "Forge 1.20.1, 1.21.1–26.3; NeoForge 1.20.6, 1.21.1–26.3; Fabric ..." */
    fun testedText(): String = TESTED.groupBy({ it.first }, { (_, from, to) -> if (from == to) from else "$from–$to" })
        .entries.joinToString("; ") { (loader, versions) -> "${loader.title} ${versions.joinToString(", ")}" }

    fun detect(files: ProjectFiles): ModProject {
        val gradle = files.read("build.gradle") ?: files.read("build.gradle.kts") ?: ""
        val properties = parseProperties(files.read("gradle.properties") ?: "")
        val fabricJson = files.read("$RESOURCES/fabric.mod.json")
        // The MDKs of 1.20.5 and later keep the toml in src/main/templates (filled by Gradle).
        val neoToml = files.read("$RESOURCES/META-INF/neoforge.mods.toml") ?: files.read("$TEMPLATES/META-INF/neoforge.mods.toml")
        val forgeToml = files.read("$RESOURCES/META-INF/mods.toml") ?: files.read("$TEMPLATES/META-INF/mods.toml")
        val problems = mutableListOf<Message>()

        val loader = when {
            fabricJson != null || Regex("fabric-loom|net\\.fabricmc").containsMatchIn(gradle) -> Loader.FABRIC
            neoToml != null || Regex("net\\.neoforged").containsMatchIn(gradle) -> Loader.NEOFORGE
            forgeToml != null || Regex("net\\.minecraftforge").containsMatchIn(gradle) -> Loader.FORGE
            else -> null
        }

        val minecraft = properties["minecraft_version"] ?: properties["mc_version"]
            ?: Regex("com\\.mojang:minecraft:([0-9][0-9.]*)").find(gradle)?.groupValues?.get(1)
            ?: Regex("minecraft\\s*[:=]\\s*['\"]?([0-9]+\\.[0-9]+(?:\\.[0-9]+)?)").find(gradle)?.groupValues?.get(1)

        var modId = properties["mod_id"]
        val toml = neoToml ?: forgeToml
        if (modId == null && toml != null) {
            modId = Regex("modId\\s*=\\s*\"([^\"]+)\"").find(toml)?.groupValues?.get(1)
        }

        var fabricMain: String? = null
        if (fabricJson != null) {
            try {
                val json = JsonParser.parseString(fabricJson).asJsonObject
                if (modId == null) {
                    modId = json.stringOrNull("id")
                }

                val main = json.getAsJsonObject("entrypoints")?.getAsJsonArray("main")?.firstOrNull()
                fabricMain = when {
                    main is JsonPrimitive && main.isString -> main.asString
                    main is JsonObject -> main.stringOrNull("value")
                    else -> null
                }
            } catch (_: Exception) {
                problems.add(Message("fabric.mod.json is not valid JSON."))
            }
        }

        if (modId != null && modId.contains("\${")) {
            // "${mod_id}" in the toml: the value comes from gradle.properties.
            modId = properties[modId.removePrefix("\${").removeSuffix("}")]
        }

        var modPackage: String? = when {
            fabricMain != null && fabricMain.contains('.') -> fabricMain.substringBeforeLast('.')
            loader == Loader.FORGE || loader == Loader.NEOFORGE -> findModPackage(files)
            else -> null
        }
        modPackage = modPackage ?: properties["mod_group_id"] ?: properties["maven_group"]

        val mappings = when {
            loader == Loader.FABRIC && Regex("officialMojangMappings\\s*\\(").containsMatchIn(gradle) -> Mappings.MOJANG
            loader == Loader.FABRIC && (gradle.contains("yarn") || properties.containsKey("yarn_mappings")) -> Mappings.YARN
            loader == Loader.FABRIC -> Mappings.UNKNOWN
            // Forge and NeoForge use the names of Mojang (with Parchment or not).
            loader != null -> Mappings.MOJANG
            else -> Mappings.UNKNOWN
        }

        val fabricApi = loader == Loader.FABRIC
            && (Regex("fabric-api|fabric_version|fabric_api_version").containsMatchIn(gradle) || properties.containsKey("fabric_version"))
        return ModProject(loader, minecraft, modId, modPackage, mappings, fabricApi, problems)
    }

    /** The package of the class with @Mod (Forge, NeoForge). */
    private fun findModPackage(files: ProjectFiles): String? {
        for (path in files.javaFiles()) {
            val text = files.read(path) ?: continue
            if (Regex("@Mod\\s*\\(").containsMatchIn(text)) {
                return Regex("^\\s*package\\s+([\\w.]+)\\s*;", RegexOption.MULTILINE).find(text)?.groupValues?.get(1)
            }
        }

        return null
    }

    fun parseProperties(text: String): Map<String, String> {
        val values = linkedMapOf<String, String>()
        for (line in text.lines()) {
            val match = Regex("^\\s*([\\w.\\-]+)\\s*[=:]\\s*(.*?)\\s*$").find(line)
            if (match != null && !line.trim().startsWith("#")) {
                values[match.groupValues[1]] = match.groupValues[2]
            }
        }

        return values
    }

    /** [1, 21, 1] for "1.21.1"; null when it is not a version. */
    fun parseVersion(text: String?): List<Int>? {
        val match = Regex("^(\\d+)\\.(\\d+)(?:\\.(\\d+))?").find((text ?: "").trim()) ?: return null
        return listOf(match.groupValues[1].toInt(), match.groupValues[2].toInt(), match.groupValues[3].ifEmpty { "0" }.toInt())
    }

    fun compareVersions(a: List<Int>, b: List<Int>): Int {
        for (i in 0 until 3) {
            val difference = a.getOrElse(i) { 0 } - b.getOrElse(i) { 0 }
            if (difference != 0) {
                return difference
            }
        }

        return 0
    }

    fun support(project: ModProject): Support {
        val problems = project.problems.toMutableList()
        fun refuse(text: String, vararg args: String) = Support(false, false, problems = problems + Message(text, *args))

        val loader = project.loader
            ?: return refuse("No Forge, NeoForge or Fabric mod found in this folder (no mods.toml, neoforge.mods.toml or fabric.mod.json).")
        val version = parseVersion(project.minecraft)
            ?: return refuse("The version of Minecraft was not found (minecraft_version in gradle.properties).")
        if (project.modId == null) {
            return refuse("The mod id was not found (mod_id in gradle.properties, modId in mods.toml or id in fabric.mod.json).")
        }

        if (project.modPackage == null) {
            return refuse("The package of the mod was not found (the class with @Mod, or the main entry point of fabric.mod.json).")
        }

        val minecraft = project.minecraft ?: ""
        if (compareVersions(version, listOf(1, 20, 0)) < 0) {
            return refuse("Minecraft {0} is not supported: Sparkle needs 1.20 or later.", minecraft)
        }

        val variant = if (compareVersions(version, listOf(1, 20, 5)) < 0) "1.20" else "1.21"
        var adapter = loader
        if (loader == Loader.NEOFORGE && compareVersions(version, listOf(1, 20, 1)) == 0) {
            // NeoForge 1.20.1 is the Forge of then: same packages.
            adapter = Loader.FORGE
        } else if (loader == Loader.NEOFORGE && variant == "1.20") {
            return refuse("NeoForge {0} is not supported: NeoForge 1.20.1 or 1.20.5 and later.", minecraft)
        }

        // Minecraft 26.1 and later is not obfuscated: no mappings.
        val unobfuscated = compareVersions(version, listOf(26, 1, 0)) >= 0
        if (loader == Loader.FABRIC) {
            if (project.mappings == Mappings.YARN && !unobfuscated) {
                return refuse("This Fabric project uses the Yarn mappings: the runtime of Sparkle is written with the names of Mojang. Switch to \"mappings loom.officialMojangMappings()\" in build.gradle.")
            }

            if (project.mappings == Mappings.UNKNOWN && !unobfuscated) {
                problems.add(Message("The mappings of the project were not found: the runtime needs the names of Mojang (loom.officialMojangMappings())."))
            }

            if (!project.fabricApi) {
                problems.add(Message("Fabric API was not found in build.gradle: the runtime needs it (particles and resource reload)."))
            }
        }

        val tested = isTested(loader, version)
        if (!tested) {
            problems.add(Message("{0} {1} was not tested: the runtime was compiled on {2}.", loader.title, minecraft, testedText()))
        }

        if (compareVersions(version, parseVersion(LATEST_TESTED)!!) > 0) {
            problems.add(Message("Minecraft {0} is newer than {1}, the last version tested: the classes of the game may have changed and the runtime may not compile.",
                minecraft, LATEST_TESTED))
        }

        val quadParticles = compareVersions(version, listOf(1, 21, 9)) >= 0
        val renames = RENAMES.filter { compareVersions(version, it.since) >= 0 && (it.loader == null || it.loader == adapter) }
        // NeoForge 1.21.4 and later: no "bus" in @EventBusSubscriber, and named reload listeners.
        val adapterUpdates = if (adapter == Loader.NEOFORGE && compareVersions(version, listOf(1, 21, 4)) >= 0) listOf("neoforge-1.21.4") else emptyList()
        return Support(true, tested, adapter, variant, quadParticles, adapterUpdates, renames, problems)
    }

    /** Package of the runtime: a sub-package of the mod. */
    fun runtimePackage(project: ModProject): String = "${project.modPackage}.sparkle"

    /**
     * The runtime folders to copy, in this order: common, variant, loader. A file of a later folder replaces the file of
     * the same name of an earlier one (mc1.21.9/SparkleParticle.java replaces common/SparkleParticle.java).
     */
    fun runtimeFolders(support: Support): List<String> =
        listOf("common", "mc${support.variant}") + (if (support.quadParticles) listOf("mc1.21.9") else emptyList()) +
            (support.adapter ?: Loader.FORGE).id + support.adapterUpdates

    /** A file of the runtime with its tokens replaced, and the names changed by Mojang since it was written. */
    fun fillTemplate(text: String, packageName: String, modId: String, renames: List<Rename> = emptyList()): String =
        renames.fold(text.replace("__PACKAGE__", packageName).replace("__MODID__", modId)) { result, rename ->
            result.replace(Regex("\\b${Regex.escape(rename.from)}\\b"), rename.to)
        }

    private fun JsonObject.stringOrNull(name: String): String? =
        get(name)?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isString }?.asString
}
