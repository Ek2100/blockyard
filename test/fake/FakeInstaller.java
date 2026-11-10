import java.nio.file.*;

/** Pretends to be the NeoForge installer: `java -jar installer.jar --installServer` lays out run.sh/run.bat + args files, like the real one. */
public class FakeInstaller {
    public static void main(String[] args) throws Exception {
        if (args.length == 0 || !args[0].equals("--installServer")) { System.err.println("expected --installServer"); System.exit(2); }
        Path self = Paths.get(FakeInstaller.class.getProtectionDomain().getCodeSource().getLocation().toURI());
        String lib = "libraries/net/neoforged/neoforge/21.1.77";
        Files.createDirectories(Paths.get(lib));
        Files.copy(self, Paths.get(lib, "fake-server.jar"), StandardCopyOption.REPLACE_EXISTING);
        Files.write(Paths.get(lib, "unix_args.txt"), ("-cp " + lib + "/fake-server.jar FakeServer\n").getBytes());
        Files.write(Paths.get(lib, "win_args.txt"), ("-cp " + lib + "/fake-server.jar FakeServer\n").getBytes());
        Files.write(Paths.get("user_jvm_args.txt"), "# Xmx4G\n".getBytes());
        Files.write(Paths.get("run.sh"), ("#!/usr/bin/env sh\n# NeoForge run script\n\njava @user_jvm_args.txt @" + lib + "/unix_args.txt \"$@\"\n").getBytes());
        Files.write(Paths.get("run.bat"), ("@echo off\r\nREM NeoForge run script\r\n\r\njava @user_jvm_args.txt @" + lib + "/win_args.txt %*\r\npause\r\n").getBytes());
        for (int i = 0; i < 5; i++) System.out.println("Downloading library " + i + "... ok");
        System.out.println("The server installed successfully");
    }
}
