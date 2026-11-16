package com.mineengine.sparkle.install

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class InstallTest {
    private class MapFiles(private val files: Map<String, String>) : ProjectFiles {
        override fun read(path: String) = files[path]
        override fun javaFiles() = files.keys.filter { it.startsWith("src/main/java/") && it.endsWith(".java") }
    }

    @Test
    fun detectsNeoForge() {
        val project = ProjectDetection.detect(MapFiles(mapOf(
            "build.gradle" to "plugins { id 'net.neoforged.moddev' }",
            "gradle.properties" to "minecraft_version=1.21.1\nmod_id=mymod\n",
            "src/main/templates/META-INF/neoforge.mods.toml" to "modId=\"\${mod_id}\"",
            "src/main/java/com/example/mymod/MyMod.java" to "package com.example.mymod;\n@Mod(MyMod.ID)\npublic class MyMod {}",
        )))
        assertEquals(Loader.NEOFORGE, project.loader)
        assertEquals("mymod", project.modId)
        assertEquals("com.example.mymod", project.modPackage)
        val support = ProjectDetection.support(project)
        assertTrue(support.supported)
        assertTrue(support.tested)
        assertEquals(listOf("common", "mc1.21", "neoforge"), ProjectDetection.runtimeFolders(support))
    }

    @Test
    fun refusesYarn() {
        val project = ProjectDetection.detect(MapFiles(mapOf(
            "build.gradle" to "plugins { id 'fabric-loom' }\nmappings \"net.fabricmc:yarn:\${project.yarn_mappings}\"",
            "gradle.properties" to "minecraft_version=1.20.1\nyarn_mappings=1.20.1+build.10\nfabric_version=0.92.0",
            "src/main/resources/fabric.mod.json" to """{ "id": "fab", "entrypoints": { "main": ["com.example.fab.Fab"] } }""",
        )))
        assertEquals(Mappings.YARN, project.mappings)
        assertEquals("com.example.fab", project.modPackage)
        assertFalse(ProjectDetection.support(project).supported)
    }

    @Test
    fun runtimeFoldersAndRenamesFollowTheVersion() {
        fun of(loader: Loader, minecraft: String): Pair<List<String>, List<String>> {
            val support = ProjectDetection.support(ModProject(loader, minecraft, "m", "p", Mappings.MOJANG, true, emptyList()))
            return ProjectDetection.runtimeFolders(support) to support.renames.map { it.to }
        }

        assertEquals(listOf("common", "mc1.21", "fabric") to emptyList<String>(), of(Loader.FABRIC, "1.21.8"))
        assertEquals(listOf("common", "mc1.21", "mc1.21.9", "fabric"), of(Loader.FABRIC, "1.21.9").first)
        assertEquals(listOf("common", "mc1.21", "neoforge"), of(Loader.NEOFORGE, "1.21.3").first)
        assertEquals(listOf("common", "mc1.21", "neoforge", "neoforge-1.21.4"), of(Loader.NEOFORGE, "1.21.4").first)
        assertEquals(listOf("net.minecraftforge.eventbus.api.listener.SubscribeEvent"), of(Loader.FORGE, "1.21.6").second)
        assertEquals(listOf("Identifier", "getLightCoords", "ParticleProviderRegistry"), of(Loader.FABRIC, "26.1").second)
        assertTrue(ProjectDetection.support(ModProject(Loader.FORGE, "26.3", "m", "p", Mappings.MOJANG, false, emptyList())).tested)
        assertFalse(ProjectDetection.support(ModProject(Loader.FORGE, "1.21", "m", "p", Mappings.MOJANG, false, emptyList())).tested)
    }

    @Test
    fun renamesChangeWholeNamesOnly() {
        val renames = ProjectDetection.RENAMES.filter { it.to == "Identifier" || it.loader == Loader.FORGE }
        assertEquals("import net.minecraft.resources.Identifier; ResourceLocations",
            ProjectDetection.fillTemplate("import net.minecraft.resources.ResourceLocation; ResourceLocations", "p", "m", renames))
        assertEquals("import net.minecraftforge.eventbus.api.listener.SubscribeEvent;",
            ProjectDetection.fillTemplate("import net.minecraftforge.eventbus.api.SubscribeEvent;", "p", "m", renames))
    }

    @Test
    fun noMappingsNeededFrom261() {
        val support = ProjectDetection.support(ModProject(Loader.FABRIC, "26.1", "m", "p", Mappings.UNKNOWN, true, emptyList()))
        assertTrue(support.supported)
        assertFalse(support.problems.any { it.text.contains("mappings") })
    }

    @Test
    fun neoForge1201IsForge() {
        val project = ModProject(Loader.NEOFORGE, "1.20.1", "m", "p", Mappings.MOJANG, false, emptyList())
        assertEquals(Loader.FORGE, ProjectDetection.support(project).adapter)
    }

    @Test
    fun plansWithoutLosingChanges() {
        val written = "class A {}\n"
        val manifest = Manifest("0.1.0", "forge", "1.20.1", "p", mapOf("A.java" to InstallPlan.hash(written), "B.java" to InstallPlan.hash("b"),
            "Old.java" to InstallPlan.hash("old")))
        val plan = InstallPlan.plan(
            wanted = mapOf("A.java" to "class A { int x; }\n", "B.java" to "new b", "C.java" to "c", "D.java" to "d"),
            existing = mapOf("A.java" to written.replace("\n", "\r\n"), "B.java" to "b changed", "D.java" to "mine", "Old.java" to "old"),
            manifest = manifest,
        )
        assertEquals(listOf(FileStatus.UPDATE, FileStatus.MODIFIED, FileStatus.CREATE, FileStatus.FOREIGN), plan.files.map { it.status })
        assertEquals(listOf(ObsoleteFile("Old.java", false)), plan.obsolete)
    }

    @Test
    fun manifestRoundTrip() {
        val manifest = Manifest("0.1.0", "fabric", "1.21.1", "com.example.sparkle", mapOf("a" to "1"))
        assertEquals(manifest, Manifest.parse(manifest.toJson()))
        assertTrue(manifest.toJson().contains("\"package\": \"com.example.sparkle\""))
        assertNull(Manifest.parse("{ broken"))
    }

    @Test
    fun backupFolderName() {
        assertEquals(".sparkle/backup/2026-11-14T10-30-00", InstallPlan.backupFolder(java.time.Instant.parse("2026-11-14T10:30:00.123Z")))
    }

    @Test
    fun addsFabricEntryPointsKeepingTheFile() {
        val text = """
            {
              // the mod
              "schemaVersion": 1,
              "id": "fab",
              "entrypoints": {
                "main": [
                  "com.example.fab.Fab"
                ]
              }
            }
        """.trimIndent() + "\n"
        val patch = FabricModJson.patch(text, "com.example.fab.sparkle.SparkleFabric", "com.example.fab.sparkle.SparkleFabricClient")
        assertNull(patch.error)
        assertEquals(listOf("main: com.example.fab.sparkle.SparkleFabric", "client: com.example.fab.sparkle.SparkleFabricClient"), patch.added)
        assertEquals("""
            {
              // the mod
              "schemaVersion": 1,
              "id": "fab",
              "entrypoints": {
                "main": [
                  "com.example.fab.Fab",
                  "com.example.fab.sparkle.SparkleFabric"
                ],
                "client": [
                  "com.example.fab.sparkle.SparkleFabricClient"
                ]
              }
            }
        """.trimIndent() + "\n", patch.text)

        val again = FabricModJson.patch(patch.text, "com.example.fab.sparkle.SparkleFabric", "com.example.fab.sparkle.SparkleFabricClient")
        assertFalse(again.changed)
        assertEquals(patch.text, again.text)
    }

    @Test
    fun addsEntryPointsWhenThereAreNone() {
        val patch = FabricModJson.patch("{\n\t\"id\": \"fab\"\n}", "a.Main", "a.Client")
        val expected = listOf(
            "{",
            "\t\"id\": \"fab\",",
            "\t\"entrypoints\": {",
            "\t\t\"main\": [",
            "\t\t\t\"a.Main\"",
            "\t\t],",
            "\t\t\"client\": [",
            "\t\t\t\"a.Client\"",
            "\t\t]",
            "\t}",
            "}",
        ).joinToString("\n")
        assertEquals(expected, patch.text)
    }

    @Test
    fun brokenFabricJsonIsAnError() {
        assertNotNull(FabricModJson.patch("{ \"id\": ", "a.Main", "a.Client").error)
    }
}
