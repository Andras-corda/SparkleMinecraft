package com.mineengine.sparkle.editor

import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.guessProjectDir
import com.intellij.openapi.roots.ProjectRootManager
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.vfs.VirtualFileVisitor
import java.util.Base64

/** A particle texture of the project: its name in the particle atlas and its file. */
data class Texture(val name: String, val file: VirtualFile)

object Textures {
    private val TEXTURE = Regex("/assets/([^/]+)/textures/particle/(.+)\\.png$")
    private val SKIPPED = setOf("build", "out", "run", "node_modules", "bin", ".gradle", ".git", ".idea", ".sparkle")

    fun isTexture(path: String): Boolean = TEXTURE.containsMatchIn(path)

    /** The particle textures of the project: "assets/<namespace>/textures/particle/<path>.png" is "<namespace>:<path>". */
    fun find(project: Project): List<Texture> = ReadAction.compute<List<Texture>, RuntimeException> {
        val roots = (listOfNotNull(project.guessProjectDir()) + ProjectRootManager.getInstance(project).contentRoots).distinct()
        val byName = linkedMapOf<String, Texture>()
        for (root in roots) {
            VfsUtilCore.visitChildrenRecursively(root, object : VirtualFileVisitor<Unit>() {
                override fun visitFile(file: VirtualFile): Boolean {
                    if (file.isDirectory) {
                        return file.name !in SKIPPED
                    }

                    val match = TEXTURE.find(file.path) ?: return true
                    val name = "${match.groupValues[1]}:${match.groupValues[2]}"
                    // src/main/resources wins over a generated copy.
                    if (name !in byName || file.path.contains("/src/main/resources/")) {
                        byName[name] = Texture(name, file)
                    }

                    return byName.size < 2000
                }
            })
        }

        byName.values.sortedBy { it.name }
    }

    /** The image as a data: address, for the editor (it cannot read the disk). */
    fun dataUri(file: VirtualFile): String? = try {
        if (file.length > 2_000_000) null else "data:image/png;base64," + Base64.getEncoder().encodeToString(file.contentsToByteArray())
    } catch (_: Exception) {
        null
    }
}
