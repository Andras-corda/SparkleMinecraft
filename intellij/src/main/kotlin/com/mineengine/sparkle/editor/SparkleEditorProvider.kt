package com.mineengine.sparkle.editor

import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.fileEditor.FileEditorPolicy
import com.intellij.openapi.fileEditor.FileEditorProvider
import com.intellij.openapi.fileEditor.TextEditor
import com.intellij.openapi.fileEditor.TextEditorWithPreview
import com.intellij.openapi.fileEditor.impl.text.TextEditorProvider
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.ui.jcef.JBCefApp
import com.mineengine.sparkle.SparklePaths

/**
 * Opens the system files ("assets/<namespace>/sparkle/<name>.json") in the Sparkle editor, with the JSON text next to it (the buttons of the
 * editor switch between the text, both, and the Sparkle editor).
 */
class SparkleEditorProvider : FileEditorProvider, DumbAware {
    override fun accept(project: Project, file: VirtualFile): Boolean = SparklePaths.isSystem(file) && JBCefApp.isSupported()

    override fun createEditor(project: Project, file: VirtualFile): FileEditor {
        val text = TextEditorProvider.getInstance().createEditor(project, file) as TextEditor
        val document = FileDocumentManager.getInstance().getDocument(file) ?: return text
        return SparkleSplitEditor(text, SparkleWebEditor(project, file, document))
    }

    override fun getEditorTypeId(): String = "sparkle-system-editor"

    override fun getPolicy(): FileEditorPolicy = FileEditorPolicy.HIDE_DEFAULT_EDITOR
}

class SparkleSplitEditor(text: TextEditor, web: SparkleWebEditor) : TextEditorWithPreview(text, web, "Sparkle", Layout.SHOW_PREVIEW) {
    init {
        web.textEditor = text
        web.onOpenText = { setLayout(Layout.SHOW_EDITOR) }
    }
}
