package com.mineengine.sparkle

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.vfs.VirtualFile
import com.mineengine.sparkle.install.RuntimeInstaller

/** The actions of Sparkle, with the texts of the VS Code extension (translated by L10n). */
abstract class SparkleAction(private val text: String) : AnAction(), DumbAware {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(event: AnActionEvent) {
        event.presentation.text = L10n.t(text)
        event.presentation.isEnabledAndVisible = event.project != null
    }

    /** The selected file, or the file of the editor. */
    protected fun selectedFile(event: AnActionEvent): VirtualFile? {
        event.getData(CommonDataKeys.VIRTUAL_FILE)?.let { return it }
        val project = event.project ?: return null
        return FileEditorManager.getInstance(project).selectedFiles.firstOrNull()
    }
}

class NewSystemAction : SparkleAction("New particle system") {
    override fun actionPerformed(event: AnActionEvent) {
        NewSystem.run(event.project ?: return, event.getData(CommonDataKeys.VIRTUAL_FILE))
    }
}

class InstallRuntimeAction : SparkleAction("Install or update the runtime in the mod") {
    override fun actionPerformed(event: AnActionEvent) {
        RuntimeInstaller.install(event.project ?: return, selectedFile(event))
    }
}

class CopyPlayCodeAction : SparkleAction("Copy the code that plays the system") {
    override fun update(event: AnActionEvent) {
        super.update(event)
        event.presentation.isEnabledAndVisible = event.project != null && SparklePaths.isSystem(selectedFile(event))
    }

    override fun actionPerformed(event: AnActionEvent) {
        PlayCode.copy(event.project, selectedFile(event))
    }
}
