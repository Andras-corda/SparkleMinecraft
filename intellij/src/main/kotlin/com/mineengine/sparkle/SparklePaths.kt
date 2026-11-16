package com.mineengine.sparkle

import com.intellij.openapi.project.Project
import com.intellij.openapi.project.guessProjectDir
import com.intellij.openapi.roots.ProjectRootManager
import com.intellij.openapi.ui.ComboBox
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.util.ui.FormBuilder
import javax.swing.JComponent
import com.intellij.openapi.vfs.VirtualFile
import java.nio.file.Files
import java.nio.file.Path

object SparklePaths {
    private val SYSTEM = Regex("/assets/([^/]+)/sparkle/(.+)\\.json$")

    /** "mymod:fire" for ".../assets/mymod/sparkle/fire.json"; null for another file. */
    fun systemKey(file: VirtualFile): String? = SYSTEM.find(file.path)?.let { "${it.groupValues[1]}:${it.groupValues[2]}" }

    fun isSystem(file: VirtualFile?): Boolean = file != null && !file.isDirectory && systemKey(file) != null

    /** A folder "assets/<namespace>/sparkle" or one of its sub-folders. */
    fun isSystemsFolder(file: VirtualFile): Boolean = file.isDirectory && Regex("/assets/[^/]+/sparkle(/.*)?$").containsMatchIn(file.path)

    private fun isModProject(folder: Path): Boolean =
        (Files.isRegularFile(folder.resolve("build.gradle")) || Files.isRegularFile(folder.resolve("build.gradle.kts")))
            && Files.isDirectory(folder.resolve("src/main"))

    /** The project that holds a file: the nearest folder with build.gradle above it. */
    fun projectOf(file: VirtualFile): Path? {
        var folder: Path? = file.toNioPathOrNull() ?: return null
        repeat(12) {
            val current = folder ?: return null
            if (Files.isRegularFile(current.resolve("build.gradle")) || Files.isRegularFile(current.resolve("build.gradle.kts"))) {
                return current
            }

            folder = current.parent
        }

        return null
    }

    /**
     * The mod projects of the open project: a folder with build.gradle and src/main (the folder itself, or a sub-folder
     * of a multi-loader project such as "forge" or "fabric").
     */
    fun findProjects(project: Project): List<Path> {
        val roots = buildList {
            project.guessProjectDir()?.toNioPathOrNull()?.let(::add)
            ProjectRootManager.getInstance(project).contentRoots.mapNotNullTo(this) { it.toNioPathOrNull() }
        }.distinct()
        val found = linkedSetOf<Path>()
        for (root in roots) {
            if (isModProject(root)) {
                found.add(root)
            }

            Files.list(root).use { children ->
                children.filter { Files.isDirectory(it) && isModProject(it) }.forEach { found.add(it) }
            }
        }

        return found.sortedBy { it.toString() }
    }

    /** The project of the file when a file is given; asks when there are several. */
    fun chooseProject(project: Project, from: VirtualFile?): Path? {
        from?.let(::projectOf)?.let { return it }
        val projects = findProjects(project)
        if (projects.size <= 1) {
            return projects.firstOrNull()
        }

        val base = project.guessProjectDir()?.toNioPathOrNull()
        val names = projects.map { p -> base?.takeIf { p.startsWith(it) && p != it }?.relativize(p)?.toString() ?: p.toString() }.toTypedArray()
        val combo = ComboBox(names)
        val dialog = object : DialogWrapper(project) {
            init {
                title = "Sparkle"
                init()
            }

            override fun createCenterPanel(): JComponent =
                FormBuilder.createFormBuilder().addLabeledComponent(L10n.t("Which mod project?"), combo, true).panel

            override fun getPreferredFocusedComponent(): JComponent = combo
        }
        return if (dialog.showAndGet()) projects.getOrNull(combo.selectedIndex) else null
    }

    private fun VirtualFile.toNioPathOrNull(): Path? = try {
        toNioPath()
    } catch (_: UnsupportedOperationException) {
        null
    }
}
