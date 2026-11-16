package com.mineengine.sparkle

import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.jetbrains.jsonSchema.extension.JsonSchemaFileProvider
import com.jetbrains.jsonSchema.extension.JsonSchemaProviderFactory
import com.jetbrains.jsonSchema.extension.SchemaType

/** Completion and validation of the JSON text of the systems, with the schema of the VS Code extension. */
class SparkleSchemaProviderFactory : JsonSchemaProviderFactory {
    override fun getProviders(project: Project): List<JsonSchemaFileProvider> = listOf(SparkleSchemaProvider)

    private object SparkleSchemaProvider : JsonSchemaFileProvider {
        override fun isAvailable(file: VirtualFile): Boolean = SparklePaths.isSystem(file)

        override fun getName(): String = "Sparkle particle system"

        override fun getSchemaFile(): VirtualFile? =
            JsonSchemaProviderFactory.getResourceFile(SparkleSchemaProviderFactory::class.java, "/sparkle/schema.json")

        override fun getSchemaType(): SchemaType = SchemaType.embeddedSchema
    }
}
