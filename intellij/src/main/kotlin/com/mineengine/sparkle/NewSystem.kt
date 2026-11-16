package com.mineengine.sparkle

import com.google.gson.JsonParser
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.InputValidator
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.ui.ValidationInfo
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.ui.ColoredListCellRenderer
import com.intellij.ui.SimpleTextAttributes
import com.intellij.ui.components.JBList
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.FormBuilder
import com.intellij.util.ui.JBUI
import com.mineengine.sparkle.install.FolderFiles
import com.mineengine.sparkle.install.ProjectDetection
import com.mineengine.sparkle.install.RuntimeInstaller
import java.nio.file.Files
import java.nio.file.Path
import javax.swing.JComponent
import javax.swing.JList
import javax.swing.ListSelectionModel
import javax.swing.event.DocumentEvent
import javax.swing.event.DocumentListener
import kotlin.io.path.createDirectories
import kotlin.io.path.writeText
import kotlin.random.Random

/** A system offered by "New particle system", made by the code of the VS Code extension (web/export.ts). */
data class SystemTemplate(val template: String, val title: String, val description: String, val name: String, val text: Map<String, String>) {
    companion object {
        val ALL: List<SystemTemplate> by lazy {
            val stream = SystemTemplate::class.java.getResourceAsStream("/sparkle/templates.json")
                ?: error("Missing resource /sparkle/templates.json: build the plugin with Gradle (task buildWeb).")
            val json = stream.reader(Charsets.UTF_8).use { JsonParser.parseReader(it).asJsonArray }
            json.map { item ->
                val o = item.asJsonObject
                SystemTemplate(o.get("template").asString, o.get("title").asString, o.get("description").asString, o.get("name").asString,
                    o.getAsJsonObject("text").entrySet().associate { it.key to it.value.asString })
            }
        }
    }
}

object NewSystem {
    private val NAME = Regex("^[a-z0-9_][a-z0-9_./-]*$")

    /** Asks for a template and a name, writes "assets/<mod>/sparkle/<name>.json" and opens it in the editor. */
    fun run(project: Project, from: VirtualFile?) {
        val folder = systemsFolder(project, from) ?: return
        val dialog = NewSystemDialog(project, folder)
        if (!dialog.showAndGet()) {
            return
        }

        val template = dialog.template
        val file = folder.resolve("${dialog.systemName}.json")
        if (Files.exists(file)) {
            // Checked again: never write over a file.
            Messages.showErrorDialog(project, L10n.t("A system with this name already exists."), "Sparkle")
            return
        }

        file.parent.createDirectories()
        file.writeText(newIds(template.text[L10n.language] ?: template.text.getValue("en")))
        val created = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(file) ?: return
        FileEditorManager.getInstance(project).openFile(created, true)

        val root = SparklePaths.projectOf(created)
        if (root != null && !RuntimeInstaller.isInstalled(root)) {
            NotificationGroupManager.getInstance().getNotificationGroup("Sparkle")
                .createNotification("Sparkle",
                    L10n.t("The mod needs the runtime of Sparkle to play the systems in the game (a few Java classes, for Forge, NeoForge and Fabric)."),
                    NotificationType.INFORMATION)
                .addAction(NotificationAction.createSimpleExpiring(L10n.t("Install the runtime")) { RuntimeInstaller.install(project, created) })
                .notify(project)
        }
    }

    /** Each emitter of a new system gets its own identifier (the templates were made once, at build time). */
    private fun newIds(text: String): String = Regex("(\"id\": \")[0-9a-f]{32}\"").replace(text) { match ->
        match.groupValues[1] + (1..32).joinToString("") { Random.nextInt(16).toString(16) } + "\""
    }

    /** The folder "assets/<mod id>/sparkle" of the project (the selected folder when it is already one). */
    private fun systemsFolder(project: Project, from: VirtualFile?): Path? {
        if (from != null && SparklePaths.isSystemsFolder(from)) {
            return from.toNioPath()
        }

        val root = SparklePaths.chooseProject(project, from)
        if (root == null) {
            Messages.showErrorDialog(project, L10n.t("Open the folder of a mod (with build.gradle) to make a particle system."), "Sparkle")
            return null
        }

        val modId = ProjectDetection.detect(FolderFiles(root)).modId
            ?: Messages.showInputDialog(project, L10n.t("Mod id (the namespace of the resources)"), "Sparkle", null, "", object : InputValidator {
                override fun checkInput(inputString: String) = Regex("^[a-z0-9_.-]+$").matches(inputString)
                override fun canClose(inputString: String) = checkInput(inputString)
            })
            ?: return null
        return root.resolve("src/main/resources/assets/$modId/sparkle")
    }

    private class NewSystemDialog(project: Project, private val folder: Path) : DialogWrapper(project) {
        private val list = JBList(SystemTemplate.ALL)
        private val nameField = JBTextField()
        private var nameEdited = false

        val template: SystemTemplate get() = list.selectedValue ?: SystemTemplate.ALL.first()
        val systemName: String get() = nameField.text.trim()

        init {
            title = L10n.t("New particle system")
            list.selectionMode = ListSelectionModel.SINGLE_SELECTION
            list.cellRenderer = object : ColoredListCellRenderer<SystemTemplate>() {
                override fun customizeCellRenderer(list: JList<out SystemTemplate>, value: SystemTemplate, index: Int, selected: Boolean, hasFocus: Boolean) {
                    append(L10n.t(value.title), SimpleTextAttributes.REGULAR_BOLD_ATTRIBUTES)
                    append("   " + L10n.t(value.description), SimpleTextAttributes.GRAYED_ATTRIBUTES)
                }
            }
            list.addListSelectionListener {
                if (!nameEdited) {
                    nameField.text = template.name
                    nameEdited = false
                }
            }
            nameField.document.addDocumentListener(object : DocumentListener {
                override fun insertUpdate(e: DocumentEvent) = edited()
                override fun removeUpdate(e: DocumentEvent) = edited()
                override fun changedUpdate(e: DocumentEvent) = edited()
                private fun edited() {
                    if (nameField.hasFocus()) nameEdited = true
                }
            })
            list.selectedIndex = 0
            nameField.text = template.name
            init()
        }

        override fun createCenterPanel(): JComponent = FormBuilder.createFormBuilder()
            .addLabeledComponentFillVertically(L10n.t("Template of the new particle system"), JBScrollPane(list).apply {
                preferredSize = JBUI.size(560, 200)
            })
            .addLabeledComponent(L10n.t("Name of the system (the file and the name given to Sparkle.play)"), nameField, true)
            .panel

        override fun getPreferredFocusedComponent(): JComponent = nameField

        override fun doValidate(): ValidationInfo? {
            val name = systemName
            if (!NAME.matches(name) || name.endsWith("/")) {
                return ValidationInfo(L10n.t("Lower case letters, digits, \"_\", \"-\", \".\" and \"/\" only (a name of resource of Minecraft)."), nameField)
            }

            if (Files.exists(folder.resolve("$name.json"))) {
                return ValidationInfo(L10n.t("A system with this name already exists."), nameField)
            }

            return null
        }
    }
}
