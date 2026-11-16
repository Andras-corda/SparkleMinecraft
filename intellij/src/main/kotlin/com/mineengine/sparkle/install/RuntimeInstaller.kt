package com.mineengine.sparkle.install

import com.google.gson.JsonParser
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.diagnostic.thisLogger
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VfsUtil
import com.intellij.openapi.vfs.VirtualFile
import com.mineengine.sparkle.L10n
import com.mineengine.sparkle.SparklePaths
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.createDirectories
import kotlin.io.path.deleteIfExists
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.io.path.writeText

/**
 * Installs (or updates) the runtime of Sparkle in a mod project: a few Java classes in "<package of the mod>.sparkle",
 * registered by the loader without any change to the code of the mod (Fabric: two entry points in fabric.mod.json,
 * after asking). A file changed by hand is never written over without asking, and a copy goes to .sparkle/backup.
 */
object RuntimeInstaller {
    /** Version of the runtime written in the manifest. */
    const val RUNTIME_VERSION = "0.1.0"

    private fun format(message: Message) = L10n.t(message.text, *message.args.toTypedArray())

    fun install(project: Project, from: VirtualFile?) {
        val root = SparklePaths.chooseProject(project, from)
        if (root == null) {
            Messages.showErrorDialog(project, L10n.t("Open the folder of a mod (with build.gradle) to install the runtime."), "Sparkle")
            return
        }

        // The files are read from the disk: the changes not saved yet go there first.
        FileDocumentManager.getInstance().saveAllDocuments()
        val log = StringBuilder()
        val mod = ProjectDetection.detect(FolderFiles(root))
        val result = ProjectDetection.support(mod)
        log.appendLine(L10n.t("Project: {0}", root))
        log.appendLine("loader=${mod.loader?.id ?: "?"} minecraft=${mod.minecraft ?: "?"} modId=${mod.modId ?: "?"} package=${mod.modPackage ?: "?"} mappings=${mod.mappings.name.lowercase()}")
        result.problems.forEach { log.appendLine("- ${format(it)}") }

        if (!result.supported) {
            thisLogger().info(log.toString())
            Messages.showErrorDialog(project, L10n.t("The runtime cannot be installed: {0}", format(result.problems.last())), "Sparkle")
            return
        }

        val loader = mod.loader!!
        val modId = mod.modId!!
        val minecraft = mod.minecraft!!
        val packageName = ProjectDetection.runtimePackage(mod)
        val javaFolder = "src/main/java/${packageName.replace('.', '/')}"
        val wanted = linkedMapOf<String, String>()
        val index = JsonParser.parseString(resource("/sparkle/runtime/index.json")).asJsonObject
        for (folder in ProjectDetection.runtimeFolders(result)) {
            for (name in index.getAsJsonArray(folder).map { it.asString }) {
                wanted["$javaFolder/$name"] = ProjectDetection.fillTemplate(resource("/sparkle/runtime/$folder/$name"), packageName, modId, result.renames)
            }
        }

        val manifest = Manifest.parse(read(root, MANIFEST_PATH))
        val existing = (wanted.keys + manifest?.files?.keys.orEmpty()).mapNotNull { path -> read(root, path)?.let { path to it } }.toMap()
        val plan = InstallPlan.plan(wanted, existing, manifest)
        val toWrite = plan.files.filter { it.status != FileStatus.SAME }

        val warnings = result.problems.joinToString("\n") { "- ${format(it)}" }
        val summary = L10n.t("Install the Sparkle runtime for {0} {1} in the package {2}? {3} files to write, {4} already up to date.",
            loader.title, minecraft, packageName, toWrite.size, plan.files.size - toWrite.size)
        val install = L10n.t("Install")
        if (Messages.showDialog(project, if (warnings.isEmpty()) summary else "$summary\n\n$warnings", "Sparkle",
                arrayOf(install, Messages.getCancelButton()), 0, Messages.getQuestionIcon()) != 0) {
            return
        }

        // Files changed by hand, or of the user: one question each.
        val written = mutableListOf<PlannedFile>()
        val backups = mutableListOf<String>()
        for (file in toWrite) {
            if (file.status == FileStatus.MODIFIED || file.status == FileStatus.FOREIGN) {
                val replace = L10n.t("Replace (copy kept)")
                val keep = L10n.t("Keep mine")
                val question = if (file.status == FileStatus.MODIFIED) {
                    L10n.t("{0} was changed since the runtime was installed. Replace it with the new version?", file.path)
                } else {
                    L10n.t("{0} already exists and was not written by Sparkle. Replace it?", file.path)
                }

                val choice = Messages.showDialog(project, "$question\n\n${L10n.t("A copy of your file is kept in {0}.", BACKUP_FOLDER)}", "Sparkle",
                    arrayOf(replace, keep, Messages.getCancelButton()), 1, Messages.getWarningIcon())
                when (choice) {
                    0 -> backups.add(file.path)
                    1 -> {
                        log.appendLine(L10n.t("Kept: {0}", file.path))
                        continue
                    }

                    else -> {
                        notify(project, L10n.t("Cancelled: nothing was written."), NotificationType.INFORMATION)
                        return
                    }
                }
            }

            written.add(file)
        }

        var removed = emptyList<String>()
        if (plan.obsolete.isNotEmpty()) {
            val list = plan.obsolete.joinToString("\n") { "- ${it.path}${if (it.modified) " (${L10n.t("changed by hand")})" else ""}" }
            val question = L10n.t("These files of the previous install are not used any more (another loader or package): they may not compile. Move them to {0}?", BACKUP_FOLDER)
            if (Messages.showDialog(project, "$question\n\n$list", "Sparkle", arrayOf(L10n.t("Move to the backup"), L10n.t("Keep them")), 1,
                    Messages.getWarningIcon()) == 0) {
                removed = plan.obsolete.map { it.path }
            }
        }

        val backup = InstallPlan.backupFolder()
        for (path in backups + removed) {
            existing[path]?.let { write(root, "$backup/$path", it) }
        }

        for (file in written) {
            write(root, file.path, file.content)
            log.appendLine("${if (file.status == FileStatus.CREATE) "+" else "~"} ${file.path}")
        }

        for (path in removed) {
            root.resolve(path).deleteIfExists()
            log.appendLine("- $path")
        }

        // The manifest knows the files as the plugin wrote them. A file the user kept keeps the hash of the last install,
        // so that the next one still sees it as changed by hand (a file of the user stays out of it).
        val files = linkedMapOf<String, String>()
        for (file in plan.files) {
            if (file.status == FileStatus.SAME || file in written) {
                files[file.path] = InstallPlan.hash(file.content)
            } else {
                manifest?.files?.get(file.path)?.let { files[file.path] = it }
            }
        }

        for (old in plan.obsolete) {
            if (old.path !in removed) {
                manifest?.files?.get(old.path)?.let { files[old.path] = it }
            }
        }

        write(root, MANIFEST_PATH, Manifest(RUNTIME_VERSION, loader.id, minecraft, packageName, files).toJson())

        if (loader == Loader.FABRIC) {
            addFabricEntryPoints(project, root, packageName, backup, log)
        }

        if (backups.size + removed.size > 0) {
            log.appendLine(L10n.t("Copies of the replaced files: {0}", backup))
        }

        log.appendLine(L10n.t("Done. Play a system from the server: Sparkle.play(level, \"{0}:<name>\", x, y, z);", modId))
        thisLogger().info(log.toString())
        refresh(root)
        notify(project, L10n.t("Sparkle runtime installed for {0} {1}: {2} files written. Use {3}.Sparkle.play(...) from the server.",
            loader.title, minecraft, written.size, packageName), NotificationType.INFORMATION, log.toString())
    }

    /** Adds the two entry points of Sparkle to fabric.mod.json, after asking. */
    private fun addFabricEntryPoints(project: Project, root: Path, packageName: String, backup: String, log: StringBuilder) {
        val path = "src/main/resources/fabric.mod.json"
        val text = read(root, path) ?: return
        val patch = FabricModJson.patch(text, "$packageName.SparkleFabric", "$packageName.SparkleFabricClient")
        val manual = L10n.t("Add these entry points to fabric.mod.json: \"main\": \"{0}.SparkleFabric\", \"client\": \"{0}.SparkleFabricClient\".", packageName)
        if (patch.error != null) {
            log.appendLine("${L10n.t(patch.error)} $manual")
            notify(project, manual, NotificationType.WARNING)
            return
        }

        if (!patch.changed) {
            return
        }

        val question = L10n.t("On Fabric, the runtime starts from two entry points of fabric.mod.json. Add them?")
        if (Messages.showDialog(project, "$question\n\n${patch.added.joinToString("\n")}", "Sparkle", arrayOf(L10n.t("Add"), Messages.getCancelButton()), 0,
                Messages.getQuestionIcon()) != 0) {
            log.appendLine(manual)
            notify(project, manual, NotificationType.WARNING)
            return
        }

        write(root, "$backup/$path", text)
        write(root, path, patch.text)
        log.appendLine("~ $path (${patch.added.joinToString(", ")})")
    }

    fun notify(project: Project?, text: String, type: NotificationType, details: String? = null) {
        val notification = NotificationGroupManager.getInstance().getNotificationGroup("Sparkle")
            .createNotification("Sparkle", text, type)
        if (details != null) {
            notification.setContent(text + "<br><pre>" + details.trim().replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;") + "</pre>")
        }

        notification.notify(project)
    }

    private fun resource(path: String): String =
        RuntimeInstaller::class.java.getResourceAsStream(path)?.use { it.readBytes().toString(Charsets.UTF_8) }
            ?: error("Missing resource $path: build the plugin with Gradle (task buildWeb).")

    private fun read(root: Path, path: String): String? = root.resolve(path).takeIf { it.isRegularFile() }?.readText()

    private fun write(root: Path, path: String, text: String) {
        val file = root.resolve(path)
        file.parent.createDirectories()
        file.writeText(text)
    }

    /** Shows the new files in the IDE. */
    private fun refresh(root: Path) {
        LocalFileSystem.getInstance().refreshAndFindFileByNioFile(root)?.let { VfsUtil.markDirtyAndRefresh(true, true, true, it) }
    }

    /** The project has the runtime (".sparkle/runtime.json"). */
    fun isInstalled(root: Path): Boolean = Files.isRegularFile(root.resolve(MANIFEST_PATH))
}
