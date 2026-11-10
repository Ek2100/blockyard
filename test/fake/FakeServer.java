import java.io.*;
import java.net.*;
import java.nio.file.*;
import java.text.SimpleDateFormat;
import java.util.*;

/** Mimics a vanilla Minecraft server's console closely enough to exercise Blockyard. */
public class FakeServer {
    static final List<String> players = new ArrayList<>();
    static final List<String> whitelist = new ArrayList<>();
    static void saveWhitelist() throws IOException {
        StringBuilder b = new StringBuilder("[");
        for (int i = 0; i < whitelist.size(); i++) b.append(i > 0 ? "," : "").append("{\"uuid\":\"00000000-0000-0000-0000-00000000000").append(i).append("\",\"name\":\"").append(whitelist.get(i)).append("\"}");
        Files.write(Paths.get("whitelist.json"), b.append("]").toString().getBytes());
    }
    static void setProp(String key, String value) throws IOException {
        Path p = Paths.get("server.properties");
        List<String> out = new ArrayList<>(); boolean found = false;
        if (Files.exists(p)) for (String l : Files.readAllLines(p)) { if (l.startsWith(key + "=")) { out.add(key + "=" + value); found = true; } else out.add(l); }
        if (!found) out.add(key + "=" + value);
        Files.write(p, out);
    }
    static final SimpleDateFormat F = new SimpleDateFormat("HH:mm:ss");
    static void log(String level, String msg) {
        System.out.println("[" + F.format(new Date()) + "] [Server thread/" + level + "]: " + msg);
        System.out.flush();
    }
    public static void main(String[] args) throws Exception {
        int port = 25565;
        Path props = Paths.get("server.properties");
        if (Files.exists(props)) for (String l : Files.readAllLines(props)) if (l.startsWith("server-port=")) port = Integer.parseInt(l.substring(12).trim());
        log("INFO", "Starting minecraft server version 1.21.4");
        log("INFO", "Loading properties");
        long mx = Runtime.getRuntime().maxMemory() / 1048576;
        log("INFO", "Max memory: " + mx + " MB, args: " + String.join(" ", args));
        ServerSocket sock = new ServerSocket();
        sock.bind(new InetSocketAddress("0.0.0.0", port));
        log("INFO", "Starting Minecraft server on *:" + port);
        log("WARN", "**** FAKE SERVER FOR TESTING ****");
        Thread.sleep(300);
        log("INFO", "Preparing level \"world\"");
        System.out.print("\u001b[32m>\u001b[0m\r");
        log("INFO", "Done (1.234s)! For help, type \"help\"");
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in));
        String line;
        while ((line = in.readLine()) != null) {
            String[] p = line.trim().split(" ", 3);
            switch (p[0]) {
                case "tps":
                    log("INFO", "TPS from last 1m, 5m, 15m: *20.0, 19.84, 19.9");
                    break;
                case "mspt":
                    log("INFO", "Server tick times (avg/min/max) from last 5s, 10s, 1m:");
                    log("INFO", "\u25F4 3.1/1.2/9.8, 3.0/1.1/12.4, 2.9/1.0/15.0");
                    break;
                case "tick":
                    if (System.getProperty("fake.oldvanilla") != null) { log("INFO", "Unknown or incomplete command, see below for error"); log("INFO", "tick<--[HERE]"); break; }
                    log("INFO", "The game is running normally");
                    log("INFO", "Target tick rate: 20.0 per second.");
                    log("INFO", "Average time per tick: 62.5ms (Target: 50.0ms)");
                    log("INFO", "Percentiles: P50: 60.1ms P95: 70.2ms P99: 80.3ms, sample: 100");
                    break;
                case "list":
                    log("INFO", "There are " + players.size() + " of a max of 20 players online: " + String.join(", ", players));
                    break;
                case "join":
                    log("INFO", "UUID of player " + p[1] + " is 069a79f4-44e9-4726-a5be-fca90e38aaf5");
                    players.add(p[1]);
                    log("INFO", p[1] + "[/127.0.0.1:5555] logged in with entity id 1 at (0.5, 64.0, 0.5)");
                    log("INFO", p[1] + " joined the game");
                    break;
                case "leave":
                    players.remove(p[1]);
                    log("INFO", p[1] + " lost connection: Disconnected");
                    log("INFO", p[1] + " left the game");
                    break;
                case "kick":
                    if (players.remove(p[1])) {
                        log("INFO", "Kicked " + p[1] + ": " + (p.length > 2 ? p[2] : "Kicked by an operator"));
                        log("INFO", p[1] + " left the game");
                    } else log("INFO", "No player was found");
                    break;
                case "chat":
                    log("INFO", "<Bob> Steve joined the game");
                    break;
                case "op":
                    Files.write(Paths.get("ops.json"), ("[{\"uuid\":\"x\",\"name\":\"" + p[1] + "\",\"level\":4,\"bypassesPlayerLimit\":false}]").getBytes());
                    log("INFO", "Made " + p[1] + " a server operator");
                    break;
                case "save-off":
                    log("INFO", "Automatic saving is now disabled");
                    break;
                case "save-on":
                    log("INFO", "Automatic saving is now enabled");
                    break;
                case "save-all":
                    log("INFO", "Saving the game (this may take a moment!)");
                    Thread.sleep(150);
                    log("INFO", "Saved the game");
                    break;
                case "whitelist":
                    if (p.length > 2 && p[1].equals("add")) {
                        if (whitelist.contains(p[2])) log("INFO", "Player is already whitelisted");
                        else { whitelist.add(p[2]); saveWhitelist(); log("INFO", "Added " + p[2] + " to the whitelist"); }
                    } else if (p.length > 1 && (p[1].equals("on") || p[1].equals("off"))) {
                        setProp("white-list", p[1].equals("on") ? "true" : "false");
                        log("INFO", "Whitelist is now turned " + p[1]);
                    } else log("INFO", "Unknown or incomplete command, see below for error");
                    break;
                case "say":
                    log("INFO", "[Server] " + (p.length > 1 ? line.trim().substring(4) : ""));
                    break;
                case "error":
                    log("ERROR", "Something broke");
                    System.err.println("java.lang.RuntimeException: boom");
                    System.err.println("\tat FakeServer.main(FakeServer.java:1)");
                    break;
                case "crash":
                    System.exit(3);
                case "hang":
                    log("INFO", "Hanging (ignores stop)");
                    while (true) Thread.sleep(1000);
                case "stop":
                    log("INFO", "Stopping the server");
                    log("INFO", "Saving worlds");
                    Thread.sleep(200);
                    sock.close();
                    System.exit(0);
                default:
                    log("INFO", "Unknown or incomplete command, see below for error");
            }
        }
    }
}
