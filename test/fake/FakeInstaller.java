import java.nio.file.*;

/** Pretends to be the NeoForge installer: `java -jar installer.jar --installServer` lays out run.sh + an args file. */
public class FakeInstaller {
    public static void main(String[] args) throws Exception {
        if (args.length == 0 || !args[0].equals("--installServer")) { System.err.println("expected --installServer"); System.exit(2); }
        Path self = Paths.get(FakeInstaller.class.getProtectionDomain().getCodeSource().getLocation().toURI());
        Path lib = Paths.get("libraries/net/neoforged/neoforge/21.1.77");
        Files.createDirectories(lib);
        Files.copy(self, lib.resolve("fake-server.jar"), StandardCopyOption.REPLACE_EXISTING);
        Files.write(lib.resolve("unix_args.txt"), ("-cp " + lib.resolve("fake-server.jar") + " FakeServer\n").getBytes());
        Files.write(Paths.get("user_jvm_args.txt"), "# Xmx4G\n".getBytes());
        Files.write(Paths.get("run.sh"), ("#!/usr/bin/env sh\n# NeoForge run script\n\njava @user_jvm_args.txt @" + lib + "/unix_args.txt \"$@\"\n").getBytes());
        for (int i = 0; i < 5; i++) System.out.println("Downloading library " + i + "... ok");
        System.out.println("The server installed successfully");
    }
}
