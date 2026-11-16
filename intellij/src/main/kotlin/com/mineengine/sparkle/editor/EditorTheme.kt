package com.mineengine.sparkle.editor

import com.intellij.openapi.editor.colors.EditorColorsManager
import com.intellij.ui.JBColor
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.NamedColorUtil
import com.intellij.util.ui.UIUtil
import java.awt.Color

/** The colors of the IDE, given to the editor with the names of the colors of VS Code (its style uses them). */
object EditorTheme {
    fun css(): String {
        val scheme = EditorColorsManager.getInstance().globalScheme
        val foreground = UIUtil.getLabelForeground()
        val selection = UIUtil.getListSelectionBackground(true)
        val selectionForeground = UIUtil.getListSelectionForeground(true)
        val border = JBColor.border()
        val font = UIUtil.getLabelFont()
        val colors = mapOf(
            "foreground" to foreground,
            "editor-background" to scheme.defaultBackground,
            "sideBar-background" to UIUtil.getPanelBackground(),
            "sideBarTitle-foreground" to foreground,
            "panel-border" to border,
            "input-background" to UIUtil.getTextFieldBackground(),
            "input-foreground" to UIUtil.getTextFieldForeground(),
            "input-border" to JBColor.namedColor("Component.borderColor", border),
            "button-secondaryBackground" to JBColor.namedColor("Button.startBackground", UIUtil.getPanelBackground()),
            "button-secondaryForeground" to JBColor.namedColor("Button.foreground", foreground),
            "button-secondaryHoverBackground" to JBUI.CurrentTheme.ActionButton.hoverBackground(),
            "icon-foreground" to foreground,
            "focusBorder" to JBUI.CurrentTheme.Focus.focusColor(),
            "list-hoverBackground" to JBUI.CurrentTheme.List.Hover.background(true),
            "list-activeSelectionBackground" to selection,
            "list-activeSelectionForeground" to selectionForeground,
            "textLink-foreground" to JBUI.CurrentTheme.Link.Foreground.ENABLED,
            "badge-background" to selection,
            "badge-foreground" to selectionForeground,
            "errorForeground" to NamedColorUtil.getErrorForeground(),
            "editorError-foreground" to NamedColorUtil.getErrorForeground(),
            "editorWarning-foreground" to JBColor(Color(0xB0, 0x80, 0x00), Color(0xE0, 0xB0, 0x40)),
        )
        val variables = colors.entries.joinToString("\n") { (name, color) -> "  --vscode-$name: ${css(color)};" }
        return """
            :root {
            $variables
              --vscode-font-family: "${font.family}", system-ui, sans-serif;
              --vscode-font-size: ${font.size}px;
              --vscode-editor-font-family: "${scheme.editorFontName}", monospace;
            }
        """.trimIndent()
    }

    private fun css(color: Color): String =
        if (color.alpha == 255) "#%02x%02x%02x".format(color.red, color.green, color.blue)
        else "rgba(${color.red}, ${color.green}, ${color.blue}, ${"%.3f".format(java.util.Locale.ROOT, color.alpha / 255.0)})"
}
