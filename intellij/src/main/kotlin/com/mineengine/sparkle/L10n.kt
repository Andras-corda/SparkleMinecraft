package com.mineengine.sparkle

import com.google.gson.JsonParser
import com.intellij.DynamicBundle

/**
 * The texts of the plugin. They are the English texts of the VS Code extension; the French ones come from its bundle
 * (vscode/l10n/bundle.l10n.fr.json), so that both plugins say the same thing.
 */
object L10n {
    private val french: Map<String, String> by lazy {
        val stream = L10n::class.java.getResourceAsStream("/sparkle/l10n.fr.json") ?: return@lazy emptyMap()
        val json = stream.reader(Charsets.UTF_8).use { JsonParser.parseReader(it).asJsonObject }
        json.entrySet().associate { it.key to it.value.asString }
    }

    val isFrench: Boolean
        get() = DynamicBundle.getLocale().language == "fr"

    /** The text in the language of the IDE, with {0}, {1}... replaced. */
    fun t(text: String, vararg args: Any): String {
        val translated = (if (isFrench) french[text] else null) ?: text
        return Regex("\\{(\\d+)}").replace(translated) { match ->
            args.getOrNull(match.groupValues[1].toInt())?.toString() ?: match.value
        }
    }

    /** Every translation, for the editor (it translates by itself and falls back on the English text). */
    fun strings(): Map<String, String> = if (isFrench) french else emptyMap()

    /** "en" or "fr": the language of the templates. */
    val language: String
        get() = if (isFrench) "fr" else "en"
}
