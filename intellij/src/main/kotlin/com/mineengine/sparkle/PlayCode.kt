package com.mineengine.sparkle

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.notification.NotificationType
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.VirtualFile
import com.mineengine.sparkle.install.RuntimeInstaller
import java.awt.datatransfer.StringSelection

/** The Java code that plays a system, with its user parameters. */
object PlayCode {
    fun code(key: String, text: String): String {
        val parameters = userParameters(text).map { parameter ->
            val name = parameter.string("name") ?: parameter.string("id") ?: ""
            val value = parameter.string("value") ?: ""
            when (parameter.string("type")) {
                "Vector" -> ".vector(\"$name\", 0, 0, 0)"
                "Color" -> ".color(\"$name\", 0x${value.removePrefix("#").ifEmpty { "FFFFFF" }.uppercase()})"
                "Boolean" -> ".flag(\"$name\", ${value == "true"})"
                else -> ".number(\"$name\", ${value.ifEmpty { "0" }})"
            }
        }

        return if (parameters.isEmpty()) {
            "Sparkle.play(level, \"$key\", x, y, z);"
        } else {
            "Sparkle.play(level, \"$key\", x, y, z, SparkleParameters.create()${parameters.joinToString("")});"
        }
    }

    /** The user parameters of the file (a file of Mine Engine keeps them in "properties"). */
    private fun userParameters(text: String): List<JsonObject> = try {
        val root = JsonParser.parseString(text).asJsonObject
        val body = root.get("properties")?.takeIf { it.isJsonObject }?.asJsonObject ?: root
        body.getAsJsonArray("userParameters")?.filter { it.isJsonObject && it.asJsonObject.string("id") != null }?.map { it.asJsonObject } ?: emptyList()
    } catch (_: Exception) {
        emptyList()
    }

    private fun JsonObject.string(name: String): String? = get(name)?.takeIf { it.isJsonPrimitive }?.asString

    fun copy(project: Project?, file: VirtualFile?) {
        val key = file?.let(SparklePaths::systemKey)
        if (file == null || key == null) {
            Messages.showErrorDialog(project, L10n.t("Select a particle system (assets/<mod>/sparkle/<name>.json)."), "Sparkle")
            return
        }

        val text = FileDocumentManager.getInstance().getDocument(file)?.text ?: String(file.contentsToByteArray(), file.charset)
        val code = code(key, text)
        CopyPasteManager.getInstance().setContents(StringSelection(code))
        RuntimeInstaller.notify(project, L10n.t("Copied: {0}", code), NotificationType.INFORMATION)
    }
}
