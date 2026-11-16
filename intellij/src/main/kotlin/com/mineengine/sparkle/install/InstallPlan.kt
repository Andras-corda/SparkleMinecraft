package com.mineengine.sparkle.install

import com.google.gson.GsonBuilder
import com.google.gson.JsonParser
import java.security.MessageDigest
import java.time.Instant
import java.time.temporal.ChronoUnit

/*
 * Plans the install of the runtime without losing anything: a file changed by hand since the last install (or a file of
 * the user with the same name) is never written over without asking. Same rules as vscode/src/shared/install.ts, and
 * the same ".sparkle/runtime.json", so that both plugins can update an install of the other.
 */

const val MANIFEST_PATH = ".sparkle/runtime.json"
const val BACKUP_FOLDER = ".sparkle/backup"

/** ".sparkle/runtime.json": what was installed, with the hash of each file as written. */
data class Manifest(
    val runtime: String,
    val loader: String,
    val minecraft: String,
    val packageName: String,
    /** Path (relative to the project, with "/") to the SHA-256 of the file as written. */
    val files: Map<String, String>,
) {
    fun toJson(): String {
        val root = linkedMapOf<String, Any>("runtime" to runtime, "loader" to loader, "minecraft" to minecraft, "package" to packageName, "files" to files)
        return GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create().toJson(root) + "\n"
    }

    companion object {
        /** Null when it is missing or broken (every file then counts as not written by the plugin). */
        fun parse(text: String?): Manifest? {
            if (text.isNullOrBlank()) {
                return null
            }

            return try {
                val json = JsonParser.parseString(text).asJsonObject
                val files = json.getAsJsonObject("files") ?: return null
                fun string(name: String) = json.get(name)?.takeIf { it.isJsonPrimitive }?.asString ?: ""
                Manifest(string("runtime"), string("loader"), string("minecraft"), string("package"),
                    files.entrySet().associate { it.key to it.value.asString })
            } catch (_: Exception) {
                null
            }
        }
    }
}

enum class FileStatus {
    /** Not there: written. */
    CREATE,

    /** Already the same text: nothing to do. */
    SAME,

    /** Written by the last install and not changed since: written again. */
    UPDATE,

    /** Written by the last install, then changed by hand: asks. */
    MODIFIED,

    /** There, but not written by the plugin: asks. */
    FOREIGN,
}

data class PlannedFile(val path: String, val content: String, val status: FileStatus)

/** A file of the last install that the new one does not write (another loader or package). */
data class ObsoleteFile(val path: String, val modified: Boolean)

data class Plan(val files: List<PlannedFile>, val obsolete: List<ObsoleteFile>)

object InstallPlan {
    /** SHA-256 of a text, line endings ignored (git may change them). */
    fun hash(text: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(normalize(text).toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it) }
    }

    private fun normalize(text: String) = text.replace("\r\n", "\n")

    fun plan(wanted: Map<String, String>, existing: Map<String, String>, manifest: Manifest?): Plan {
        val files = wanted.map { (path, content) ->
            val current = existing[path]
            val written = manifest?.files?.get(path)
            val status = when {
                current == null -> FileStatus.CREATE
                normalize(current) == normalize(content) -> FileStatus.SAME
                written == null -> FileStatus.FOREIGN
                written == hash(current) -> FileStatus.UPDATE
                else -> FileStatus.MODIFIED
            }
            PlannedFile(path, content, status)
        }

        val obsolete = (manifest?.files ?: emptyMap()).mapNotNull { (path, written) ->
            val current = existing[path]
            if (path !in wanted && current != null) ObsoleteFile(path, hash(current) != written) else null
        }

        return Plan(files, obsolete)
    }

    /** Folder of a backup: ".sparkle/backup/2026-11-14T10-30-00". */
    fun backupFolder(date: Instant = Instant.now()): String =
        "$BACKUP_FOLDER/${date.truncatedTo(ChronoUnit.SECONDS).toString().removeSuffix("Z").replace(':', '-')}"
}

data class FabricPatch(
    val text: String,
    val changed: Boolean,
    /** The entry points that were added ("main: com.example.Sparkle"). */
    val added: List<String>,
    val error: String? = null,
)

/**
 * Adds the entry points of Sparkle to fabric.mod.json ("main" and "client"), keeping the rest of the file as it is
 * (comments, order, spaces). An entry point already there is not added twice.
 */
object FabricModJson {
    fun patch(text: String, mainClass: String, clientClass: String): FabricPatch {
        var result = text
        val added = mutableListOf<String>()
        val eol = if (text.contains("\r\n")) "\r\n" else "\n"
        val unit = Regex("\n([ \t]+)\"").find(text)?.groupValues?.get(1) ?: "  "
        for ((point, className) in listOf("main" to mainClass, "client" to clientClass)) {
            val root = try {
                JsonScanner(result).parseDocument() as? JsonScanner.Obj
            } catch (_: IllegalArgumentException) {
                null
            } ?: return FabricPatch(text, false, emptyList(), "fabric.mod.json cannot be read.")

            val entrypoints = root.member("entrypoints")
            if (entrypoints != null && entrypoints !is JsonScanner.Obj) {
                return FabricPatch(text, false, emptyList(), "fabric.mod.json cannot be read.")
            }

            val list = (entrypoints as JsonScanner.Obj?)?.member(point)
            val names = (list as? JsonScanner.Arr)?.items?.map { item ->
                when (item) {
                    is JsonScanner.Str -> item.value
                    is JsonScanner.Obj -> (item.member("value") as? JsonScanner.Str)?.value
                    else -> null
                }
            } ?: emptyList()
            if (className in names) {
                continue
            }

            val quoted = "\"$className\""
            result = when {
                entrypoints == null -> insertMember(result, root, 1, unit, eol,
                    "\"entrypoints\": {$eol${unit.repeat(2)}\"$point\": [$eol${unit.repeat(3)}$quoted$eol${unit.repeat(2)}]$eol$unit}")
                list == null -> insertMember(result, entrypoints, 2, unit, eol,
                    "\"$point\": [$eol${unit.repeat(3)}$quoted$eol${unit.repeat(2)}]")
                list is JsonScanner.Arr -> insertMember(result, list, 3, unit, eol, quoted)
                else -> return FabricPatch(text, false, emptyList(), "fabric.mod.json cannot be read.")
            }
            added.add("$point: $className")
        }

        return FabricPatch(result, added.isNotEmpty(), added)
    }

    /** Adds an element at the end of an object or an array whose content is indented "depth" times. */
    private fun insertMember(text: String, container: JsonScanner.Container, depth: Int, unit: String, eol: String, member: String): String {
        val close = container.end - 1
        val last = container.lastValueEnd
        val indent = unit.repeat(depth)
        val closingIndent = unit.repeat(depth - 1)
        return if (last == null) {
            text.substring(0, container.start + 1) + eol + indent + member + eol + closingIndent + text.substring(close)
        } else {
            text.substring(0, last) + "," + eol + indent + member + text.substring(last)
        }
    }
}

/** A small JSON reader that keeps the positions of the values, with comments and trailing commas allowed. */
internal class JsonScanner(private val text: String) {
    sealed class Node(val start: Int, val end: Int)
    class Str(start: Int, end: Int, val value: String) : Node(start, end)
    class Other(start: Int, end: Int) : Node(start, end)
    sealed class Container(start: Int, end: Int, val lastValueEnd: Int?) : Node(start, end)
    class Obj(start: Int, end: Int, lastValueEnd: Int?, val members: List<Pair<String, Node>>) : Container(start, end, lastValueEnd) {
        fun member(name: String): Node? = members.lastOrNull { it.first == name }?.second
    }

    class Arr(start: Int, end: Int, lastValueEnd: Int?, val items: List<Node>) : Container(start, end, lastValueEnd)

    private var pos = 0

    fun parseDocument(): Node {
        val node = value()
        skip()
        require(pos == text.length) { "Text after the value at $pos" }
        return node
    }

    private fun value(): Node {
        skip()
        require(pos < text.length) { "Unexpected end" }
        return when (text[pos]) {
            '{' -> obj()
            '[' -> arr()
            '"' -> str()
            else -> other()
        }
    }

    private fun obj(): Obj {
        val start = pos++
        val members = mutableListOf<Pair<String, Node>>()
        var lastEnd: Int? = null
        while (true) {
            skip()
            require(pos < text.length) { "Unexpected end" }
            if (text[pos] == '}') {
                pos++
                return Obj(start, pos, lastEnd, members)
            }

            val key = str()
            skip()
            require(pos < text.length && text[pos] == ':') { "Missing ':' at $pos" }
            pos++
            val node = value()
            members.add(key.value to node)
            lastEnd = node.end
            skip()
            if (pos < text.length && text[pos] == ',') {
                pos++
            }
        }
    }

    private fun arr(): Arr {
        val start = pos++
        val items = mutableListOf<Node>()
        var lastEnd: Int? = null
        while (true) {
            skip()
            require(pos < text.length) { "Unexpected end" }
            if (text[pos] == ']') {
                pos++
                return Arr(start, pos, lastEnd, items)
            }

            val node = value()
            items.add(node)
            lastEnd = node.end
            skip()
            if (pos < text.length && text[pos] == ',') {
                pos++
            }
        }
    }

    private fun str(): Str {
        val start = pos
        require(pos < text.length && text[pos] == '"') { "Missing string at $pos" }
        pos++
        while (pos < text.length && text[pos] != '"') {
            pos += if (text[pos] == '\\') 2 else 1
        }

        require(pos < text.length) { "Unclosed string" }
        pos++
        val value = JsonParser.parseString(text.substring(start, pos)).asString
        return Str(start, pos, value)
    }

    private fun other(): Other {
        val start = pos
        while (pos < text.length && text[pos] !in ",]}" && !text[pos].isWhitespace() && !text.startsWith("//", pos) && !text.startsWith("/*", pos)) {
            pos++
        }

        require(pos > start) { "Unexpected '${text[pos]}' at $pos" }
        return Other(start, pos)
    }

    /** Spaces and comments. */
    private fun skip() {
        while (pos < text.length) {
            when {
                text[pos].isWhitespace() -> pos++
                text.startsWith("//", pos) -> pos = text.indexOf('\n', pos).let { if (it < 0) text.length else it }
                text.startsWith("/*", pos) -> pos = text.indexOf("*/", pos + 2).let { if (it < 0) text.length else it + 2 }
                else -> return
            }
        }
    }
}
