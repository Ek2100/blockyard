import java.io.*;
import java.net.*;
import java.nio.file.*;
import java.text.SimpleDateFormat;
import java.util.*;

/**
 * Stand-in for a Paper server, used only to take README screenshots without downloading anything.
 * It prints a believable startup log and answers the commands Blockyard sends.
 * Extra command for the screenshot script: "echo <level> <text>" prints a log line as-is.
 */
public class DemoServer {
    static final List<String> players = new ArrayList<>();
    static final SimpleDateFormat F = new SimpleDateFormat("HH:mm:ss");
    static void log(String level, String msg) { log("Server thread", level, msg); }
    static void log(String thread, String level, String msg) {
        System.out.println("[" + F.format(new Date()) + "] [" + thread + "/" + level + "]: " + msg);
        System.out.flush();
    }
    public static void main(String[] args) throws Exception {
        int port = 25565;
        Path props = Paths.get("server.properties");
        if (Files.exists(props)) for (String l : Files.readAllLines(props)) if (l.startsWith("server-port=")) port = Integer.parseInt(l.substring(12).trim());
        log("main", "INFO", "Starting minecraft server version 1.21.4");
        log("INFO", "Loading properties");
        log("INFO", "This server is running Paper version 1.21.4-232-main (Implementing API version 1.21.4-R0.1-SNAPSHOT)");
        log("INFO", "Server Ping Player Sample Count: 12");
        log("INFO", "Using 4 threads for Netty based IO");
        log("INFO", "Default game type: SURVIVAL");
        log("INFO", "Generating keypair");
        ServerSocket sock = new ServerSocket();
        sock.bind(new InetSocketAddress("0.0.0.0", port));
        log("INFO", "Starting Minecraft server on *:" + port);
        log("INFO", "Using kqueue channel type");
        Thread.sleep(150);
        log("INFO", "[LuckPerms] Loading server plugin LuckPerms v5.4.145");
        log("INFO", "[EssentialsX] Loading server plugin EssentialsX v2.21.0");
        log("INFO", "[CoreProtect] Loading server plugin CoreProtect v23.0");
        log("INFO", "[Geyser-Spigot] Loading server plugin Geyser-Spigot v2.6.0-SNAPSHOT");
        log("INFO", "[floodgate] Loading server plugin floodgate v2.2.3-SNAPSHOT");
        log("INFO", "Preparing level \"world\"");
        log("INFO", "Preparing start region for dimension minecraft:overworld");
        Thread.sleep(200);
        log("INFO", "Time elapsed: 1843 ms");
        log("INFO", "[Geyser-Spigot] Started Geyser on 0.0.0.0:19132");
        log("INFO", "Running delayed init tasks");
        log("INFO", "Done (6.412s)! For help, type \"help\"");
        server = sock;
        Path script = Paths.get("demo-script.txt");
        if (Files.exists(script)) {
            List<String> steps = Files.readAllLines(script);
            new Thread(() -> {
                try {
                    for (String s : steps) {
                        if (s.isBlank()) continue;
                        String[] parts = s.split(" ", 2);
                        Thread.sleep(Long.parseLong(parts[0]));
                        synchronized (DemoServer.class) { handle(parts.length > 1 ? parts[1] : ""); }
                    }
                } catch (Exception e) { e.printStackTrace(); }
            }).start();
        }
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in));
        String line;
        while ((line = in.readLine()) != null) synchronized (DemoServer.class) { handle(line); }
    }

    static ServerSocket server;
    static void handle(String line) throws Exception {
        ServerSocket sock = server;
        {
            String[] p = line.trim().split(" ", 3);
            switch (p[0]) {
                case "echo": {
                    String[] e = line.trim().split(" ", 3);
                    if (e.length > 2 && e[2].startsWith("@")) { String[] t = e[2].split(" ", 2); log(t[0].substring(1).replace('_', ' '), e[1], t.length > 1 ? t[1] : ""); }
                    else log(e[1], e.length > 2 ? e[2] : "");
                    break;
                }
                case "tps":
                    log("INFO", "TPS from last 1m, 5m, 15m: 20.0, 19.97, 19.94");
                    break;
                case "mspt":
                    log("INFO", "Server tick times (avg/min/max) from last 5s, 10s, 1m:");
                    log("INFO", "◴ 11.4/6.2/24.8, 11.9/6.0/28.1, 12.3/5.8/31.0");
                    break;
                case "list":
                    log("INFO", "There are " + players.size() + " of a max of 20 players online: " + String.join(", ", players));
                    break;
                case "join": {
                    String uuid = p.length > 2 ? p[2] : UUID.nameUUIDFromBytes(p[1].getBytes()).toString();
                    log("User Authenticator #1", "INFO", "UUID of player " + p[1] + " is " + uuid);
                    players.add(p[1]);
                    log("INFO", p[1] + "[/192.168.1." + (20 + players.size()) + ":5" + (1000 + players.size()) + "] logged in with entity id " + (180 + players.size() * 37) + " at ([world]-212.5, 71.0, 388.5)");
                    log("INFO", p[1] + " joined the game");
                    break;
                }
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
                case "op":
                    log("INFO", "Made " + p[1] + " a server operator");
                    break;
                case "save-off": log("INFO", "Automatic saving is now disabled"); break;
                case "save-on": log("INFO", "Automatic saving is now enabled"); break;
                case "save-all":
                    log("INFO", "Saving the game (this may take a moment!)");
                    Thread.sleep(150);
                    log("INFO", "Saved the game");
                    break;
                case "say":
                    log("INFO", "[Server] " + (p.length > 1 ? line.trim().substring(4) : ""));
                    break;
                case "stop":
                    log("INFO", "Stopping the server");
                    log("INFO", "Saving players");
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
