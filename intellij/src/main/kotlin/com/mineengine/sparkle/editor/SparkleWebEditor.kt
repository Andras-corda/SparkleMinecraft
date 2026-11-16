package com.mineengine.sparkle.editor

import com.google.gson.Gson
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.ide.ui.LafManagerListener
import com.intellij.ide.util.PropertiesComponent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.diagnostic.thisLogger
import com.intellij.openapi.command.undo.UndoManager
import com.intellij.openapi.editor.Document
import com.intellij.openapi.editor.event.DocumentEvent
import com.intellij.openapi.editor.event.DocumentListener
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.fileEditor.FileEditorState
import com.intellij.openapi.fileEditor.TextEditor
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.InputValidator
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.ui.popup.JBPopupListener
import com.intellij.openapi.ui.popup.LightweightWindowEvent
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.UserDataHolderBase
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.vfs.VirtualFileManager
import com.intellij.openapi.vfs.newvfs.BulkFileListener
import com.intellij.openapi.vfs.newvfs.events.VFileEvent
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBase
import com.intellij.ui.jcef.JBCefJSQuery
import com.mineengine.sparkle.L10n
import com.mineengine.sparkle.PlayCode
import com.mineengine.sparkle.SparklePaths
import com.mineengine.sparkle.install.RuntimeInstaller
import java.beans.PropertyChangeListener
import javax.swing.JComponent

/**
 * The visual editor of a Sparkle system: the webview of the VS Code extension in a JCEF browser, over the document of
 * the file. Every change goes through the document, so undo, redo, save and the text editor work as for any file.
 */
class SparkleWebEditor(private val project: Project, private val file: VirtualFile, private val document: Document) :
    UserDataHolderBase(), FileEditor {

    private val browser = JBCefBrowser.createBuilder().setEnableOpenDevToolsMenuItem(true).build()
    private val query = JBCefJSQuery.create(browser as JBCefBrowserBase)
    private val gson = Gson()

    /** The last text sent by the editor: its own change coming back is not sent to it again. */
    private var fromWebview: String? = null
    private var ready = false
    private var disposed = false
    private var textures: List<Texture> = emptyList()

    /** The text editor next to this one: undo and redo act on it. */
    var textEditor: TextEditor? = null

    /** Shows the text of the file ("Open as text"). */
    var onOpenText: (() -> Unit)? = null

    init {
        Disposer.register(this, browser)
        Disposer.register(this, query)
        query.addHandler { request ->
            ApplicationManager.getApplication().invokeLater {
                if (!disposed) {
                    handle(JsonParser.parseString(request).asJsonObject)
                }
            }
            null
        }

        document.addDocumentListener(object : DocumentListener {
            override fun documentChanged(event: DocumentEvent) {
                val text = document.text
                if (ready && text != fromWebview) {
                    post(mapOf("type" to "update", "text" to text))
                }
            }
        }, this)

        project.messageBus.connect(this).subscribe(VirtualFileManager.VFS_CHANGES, object : BulkFileListener {
            override fun after(events: List<VFileEvent>) {
                if (ready && events.any { Textures.isTexture(it.path) }) {
                    sendTextures()
                }
            }
        })

        ApplicationManager.getApplication().messageBus.connect(this).subscribe(LafManagerListener.TOPIC, LafManagerListener {
            browser.cefBrowser.executeJavaScript(
                "document.getElementById('sparkle-theme').textContent = ${gson.toJson(EditorTheme.css())};", browser.cefBrowser.url, 0)
        })

        browser.loadHTML(html())
    }

    private fun handle(message: JsonObject) {
        when (message.get("type")?.asString) {
            "ready" -> {
                ready = true
                findTextures { found ->
                    thisLogger().info("Sparkle editor ready: ${file.path}, ${found.size} textures")
                    post(mapOf("type" to "init", "text" to document.text, "strings" to L10n.strings(), "textures" to found,
                        "systemKey" to (SparklePaths.systemKey(file) ?: "")))
                }
            }

            "edit" -> {
                val text = message.get("text").asString
                if (text != document.text) {
                    fromWebview = text
                    WriteCommandAction.runWriteCommandAction(project, "Sparkle", null, { document.setText(text) })
                }
            }

            "pickTexture" -> {
                val request = message.get("request").asInt
                pickTexture { name -> post(mapOf("type" to "texturePicked", "request" to request, "name" to name)) }
            }

            "openText" -> onOpenText?.invoke()
            "copyPlayCode" -> PlayCode.copy(project, file)
            "installRuntime" -> RuntimeInstaller.install(project, file)
            "setState" -> PropertiesComponent.getInstance().setValue(STATE_KEY, gson.toJson(message.get("state")))
            "undo" -> textEditor?.let { editor -> UndoManager.getInstance(project).takeIf { it.isUndoAvailable(editor) }?.undo(editor) }
            "redo" -> textEditor?.let { editor -> UndoManager.getInstance(project).takeIf { it.isRedoAvailable(editor) }?.redo(editor) }
            "save" -> FileDocumentManager.getInstance().saveDocument(document)
            "error" -> thisLogger().warn("Sparkle editor: ${message.get("message")?.asString}")
        }
    }

    /** Sends a message to the editor, as the postMessage of VS Code. */
    private fun post(message: Any) {
        browser.cefBrowser.executeJavaScript("window.postMessage(${gson.toJson(message)}, '*');", browser.cefBrowser.url, 0)
    }

    /** Finds the textures out of the UI thread, then gives them (with their image) on the UI thread. */
    private fun findTextures(then: (List<Map<String, String>>) -> Unit) {
        ApplicationManager.getApplication().executeOnPooledThread {
            val found = Textures.find(project)
            val entries = found.map { mapOf("name" to it.name, "uri" to (Textures.dataUri(it.file) ?: "")) }
            ApplicationManager.getApplication().invokeLater {
                if (!disposed) {
                    textures = found
                    then(entries)
                }
            }
        }
    }

    private fun sendTextures() = findTextures { post(mapOf("type" to "textures", "textures" to it)) }

    /** A texture of the project, or one typed by hand ("minecraft:flame"). */
    private fun pickTexture(then: (String?) -> Unit) {
        val typed = L10n.t("Type a texture of the game or of another mod (\"minecraft:flame\")...")
        val items = textures.map { it.name } + typed
        var chosen = false
        JBPopupFactory.getInstance().createPopupChooserBuilder(items)
            .setTitle(L10n.t("Texture of the particles (assets/<namespace>/textures/particle/)"))
            .setNamerForFiltering { it }
            .setItemChosenCallback { item ->
                chosen = true
                if (item != typed) {
                    then(item)
                } else {
                    ApplicationManager.getApplication().invokeLater { then(askTextureName()) }
                }
            }
            .addListener(object : JBPopupListener {
                override fun onClosed(event: LightweightWindowEvent) {
                    if (!event.isOk && !chosen) {
                        then(null)
                    }
                }
            })
            .createPopup()
            .showInCenterOf(browser.component)
    }

    private fun askTextureName(): String? {
        val pattern = Regex("^[a-z0-9_.-]+:[a-z0-9_./-]+$")
        return Messages.showInputDialog(project, L10n.t("Name in the particle atlas: namespace:name"), "Sparkle", null, "minecraft:",
            object : InputValidator {
                override fun checkInput(inputString: String) = pattern.matches(inputString)
                override fun canClose(inputString: String) = pattern.matches(inputString)
            })
    }

    private fun html(): String {
        val script = resource("/sparkle/webview.js").replace("</script", "<\\/script")
        val style = resource("/sparkle/editor.css")
        val state = PropertiesComponent.getInstance().getValue(STATE_KEY)?.let { runCatching { JsonParser.parseString(it) }.getOrNull() }
        val bridge = """
            (function () {
                var state = ${gson.toJson(state as JsonElement?)};
                function send(message) {
                    var request = JSON.stringify(message);
                    ${query.inject("request")}
                }
                window.addEventListener('error', function (event) {
                    send({ type: 'error', message: event.message + ' (' + event.filename + ':' + event.lineno + ')' });
                });
                window.acquireVsCodeApi = function () {
                    return {
                        postMessage: send,
                        getState: function () { return state; },
                        setState: function (value) { state = value; send({ type: 'setState', state: value }); }
                    };
                };
                // Undo, redo and save of the IDE (not in a text field, which has its own undo).
                document.addEventListener('keydown', function (event) {
                    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
                    var key = event.key.toLowerCase();
                    var target = event.target;
                    var typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
                    var type = key === 's' ? 'save'
                        : typing ? null
                        : key === 'z' && !event.shiftKey ? 'undo'
                        : key === 'y' || (key === 'z' && event.shiftKey) ? 'redo' : null;
                    if (type) { event.preventDefault(); send({ type: type }); }
                }, true);
            })();
        """.trimIndent()
        return """
            <!DOCTYPE html>
            <html lang="${L10n.language}">
            <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Sparkle</title>
            <style id="sparkle-theme">${EditorTheme.css()}</style>
            <style>$style</style>
            <script>$bridge</script>
            </head>
            <body>
            <div id="app"></div>
            <script>$script</script>
            </body>
            </html>
        """.trimIndent()
    }

    override fun getComponent(): JComponent = browser.component

    override fun getPreferredFocusedComponent(): JComponent = browser.component

    override fun getName(): String = "Sparkle"

    override fun getFile(): VirtualFile = file

    override fun setState(state: FileEditorState) {
    }

    override fun isModified(): Boolean = false

    override fun isValid(): Boolean = file.isValid

    override fun addPropertyChangeListener(listener: PropertyChangeListener) {
    }

    override fun removePropertyChangeListener(listener: PropertyChangeListener) {
    }

    override fun dispose() {
        disposed = true
    }

    private companion object {
        const val STATE_KEY = "sparkle.editor.state"

        fun resource(path: String): String =
            SparkleWebEditor::class.java.getResourceAsStream(path)?.use { it.readBytes().toString(Charsets.UTF_8) }
                ?: error("Missing resource $path: build the plugin with Gradle (task buildWeb).")
    }
}
