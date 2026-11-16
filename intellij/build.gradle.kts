import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType
import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.dsl.KotlinVersion

plugins {
    id("org.jetbrains.kotlin.jvm") version "2.2.20"
    id("org.jetbrains.intellij.platform") version "2.20.1"
}

group = "com.mineengine"
version = providers.gradleProperty("pluginVersion").get()

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        val localIde = providers.gradleProperty("localIde").orNull
        if (localIde != null) {
            local(localIde)
        } else {
            create("IC", providers.gradleProperty("platformVersion").get())
        }

        bundledPlugin("com.intellij.modules.json")
    }

    testImplementation("junit:junit:4.13.2")
}

kotlin {
    jvmToolchain(21)
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_21)
        // The Kotlin library of IntelliJ 2024.3 is used at run time.
        apiVersion.set(KotlinVersion.KOTLIN_2_0)
        languageVersion.set(KotlinVersion.KOTLIN_2_0)
    }
}

intellijPlatform {
    pluginConfiguration {
        version = providers.gradleProperty("pluginVersion")
        ideaVersion {
            sinceBuild = providers.gradleProperty("pluginSinceBuild")
            untilBuild = provider { null }
        }
    }

    publishing {
        token = providers.environmentVariable("JETBRAINS_MARKETPLACE_TOKEN")
    }

    // "gradlew verifyPlugin": checks the plugin against the oldest supported IntelliJ and a recent one.
    pluginVerification {
        ides {
            create(IntelliJPlatformType.IntellijIdeaCommunity, providers.gradleProperty("platformVersion").get())
            providers.gradleProperty("localIde").orNull?.let { local(it) }
        }
    }
}

// The editor, the texts, the schema, the runtime and the templates come from the VS Code extension (../vscode), so that
// both plugins stay the same. Needs Node and "npm install" in ../vscode.
val webOutput = layout.buildDirectory.dir("generated/sparkle-web")
val buildWeb = tasks.register<Exec>("buildWeb") {
    description = "Builds the Sparkle editor and copies the shared files of ../vscode."
    val vscode = file("../vscode")
    inputs.dir(vscode.resolve("src"))
    inputs.dir(vscode.resolve("media"))
    inputs.dir(vscode.resolve("l10n"))
    inputs.dir(vscode.resolve("runtime"))
    inputs.dir(vscode.resolve("schemas"))
    inputs.dir("web")
    outputs.dir(webOutput)
    workingDir = projectDir
    commandLine("node", "web/build.mjs", webOutput.get().asFile.absolutePath)
}

sourceSets["main"].resources.srcDir(files(webOutput).builtBy(buildWeb))

// "gradlew runIde -PrunArgs=<project folder>|<file>" opens a mod project (and a file) in the IntelliJ of the tests.
tasks.named<org.jetbrains.intellij.platform.gradle.tasks.RunIdeTask>("runIde") {
    providers.gradleProperty("runArgs").orNull?.let { args(it.split("|")) }
}
