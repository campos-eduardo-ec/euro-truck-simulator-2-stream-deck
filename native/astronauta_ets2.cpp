/**
 * astronauta_ets2 — ponte entre o Euro Truck Simulator 2 (e o American Truck Simulator) e o
 * plugin de Stream Deck digital.astronauta.ets2.
 *
 * Usa as duas APIs oficiais do SDK da SCS (1.14):
 *   - Telemetria: lê velocidade, combustível, luzes, entrega etc. e manda um JSON por linha.
 *   - Entrada: registra um dispositivo "semântico", que o jogo entende sem configurar nada.
 *     Cada entrada tem o nome do comando do jogo (engine, parkingbrake, lblinker...), então
 *     o Stream Deck aciona o comando direto, sem simular teclado e sem o jogo em primeiro plano.
 *
 * Conversa por TCP só no 127.0.0.1, porta 47831 (variável ASTRONAUTA_ETS2_PORT troca).
 *   Jogo -> plugin: uma linha JSON por atualização ({"t":"info"} na conexão, {"t":"state"} depois).
 *   Plugin -> jogo: linhas de texto "down <comando>", "up <comando>", "tap <comando>", "ping".
 *
 * Regras do SDK respeitadas: toda chamada ao jogo acontece na thread principal, dentro de um
 * callback dele. A thread de rede só mexe na fila de comandos e no texto pronto do estado, os
 * dois protegidos por mutex.
 *
 * Compilar: ver build.sh (x86_64, o jogo no Mac roda pelo Rosetta).
 */

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#include <atomic>
#include <deque>
#include <mutex>
#include <string>
#include <vector>

#include "scssdk_telemetry.h"
#include "scssdk_input.h"
#include "eurotrucks2/scssdk_eut2.h"
#include "eurotrucks2/scssdk_telemetry_eut2.h"
#include "amtrucks/scssdk_ats.h"
#include "amtrucks/scssdk_telemetry_ats.h"
#include "common/scssdk_telemetry_common_configs.h"
#include "common/scssdk_telemetry_common_channels.h"
#include "common/scssdk_telemetry_common_gameplay_events.h"
#include "common/scssdk_telemetry_truck_common_channels.h"
#include "common/scssdk_telemetry_trailer_common_channels.h"
#include "common/scssdk_telemetry_job_common_channels.h"

#define BRIDGE_VERSION "1.0.0"
#define DEFAULT_PORT 47831

// ============================================================================ comandos

/**
 * Comandos semânticos aceitos pelo jogo (1.60). Tirados do def/... default_input.sii do
 * próprio jogo: toda "mix" cuja expressão termina em "semantical.<nome>?0".
 * A ordem aqui é o índice da entrada no dispositivo.
 */
static const char *const COMMANDS[] = {
    "accmode", "activate", "adjuster", "advmouse", "advoptions", "advzoomin", "advzoomout",
    "airhorn", "assistact1", "assistact2", "assistact3", "assistact4", "assistact5", "attach",
    "beacon", "cam1", "cam3", "camcycle", "camreset", "camwalk_back", "camwalk_for",
    "camwalk_jump", "camwalk_left", "camwalk_righ", "camwalk_run", "camzoom", "chat_act",
    "cruiectrl", "cruiectrldec", "cruiectrlinc", "cruiectrlres", "dashmapzoom", "diflock",
    "display", "drive", "embrake", "engbrakeauto", "engbrakedwn", "engbraketog", "engbrakeup",
    "engine", "engineelect", "flasher4way", "frontsuspdwn", "frontsuspup", "gear0", "gear1",
    "gear2", "gear3", "gear4", "gear5", "gear6", "gear7", "gear8", "gear9", "gear10", "gear11",
    "gear12", "gear13", "gear14", "gear15", "gear16", "geardown", "geardownhint", "geardrive",
    "gearreverse", "gearsel1off", "gearsel1on", "gearsel1tgl", "gearsel2off", "gearsel2on",
    "gearsel2tgl", "gearup", "gearuphint", "hblight", "horn", "infotainment", "laneassist",
    "laneassmode", "lblinker", "liftaxle", "liftaxlet", "light", "lighthorn", "lwinclose",
    "lwinopen", "menu", "motorbrake", "mpptt", "name_tags", "navmap", "parkingbrake",
    "photo_mode", "photo_zoom", "photorolll", "photorollr", "quick_chat", "radio", "radiodown",
    "radionext", "radioprev", "radioup", "rblinker", "rearsuspdwn", "rearsuspup",
    "retarderauto", "retarderdown", "retarderup", "reverse", "rwinclose", "rwinopen",
    "screenshot", "services", "showhud", "showmirrors", "suspreset", "trailerbrake",
    "tranpwrmode", "transemi", "tripreset", "wipers", "wipersback",
};
static const unsigned COMMAND_COUNT = sizeof(COMMANDS) / sizeof(COMMANDS[0]);

static int command_index(const char *name) {
    for (unsigned i = 0; i < COMMAND_COUNT; ++i)
        if (strcmp(COMMANDS[i], name) == 0) return (int)i;
    return -1;
}

// ============================================================================ log

static scs_log_t game_log = NULL;

static void blog(scs_log_type_t type, const char *fmt, ...) {
    if (!game_log) return;
    char buf[512];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    std::string msg = std::string("[astronauta] ") + buf;
    game_log(type, msg.c_str());
}

// ============================================================================ estado (thread principal)

struct Telemetry {
    // tempo e pausa
    bool paused = true;
    scs_u32_t game_time = 0;          // minutos desde o início do jogo
    scs_s32_t rest_stop = 0;          // minutos até o descanso obrigatório
    float local_scale = 0;

    // movimento e motor
    float speed = 0, rpm = 0, cruise = 0, odometer = 0;
    scs_s32_t gear = 0, dgear = 0;
    bool engine = false, electric = false;

    // freios
    bool parking = false, motor_brake = false;
    scs_u32_t retarder = 0;
    float air = 0, brake_temp = 0;
    bool air_warn = false, air_emerg = false;

    // fluidos e painel
    float fuel = 0, fuel_range = 0, fuel_avg = 0, adblue = 0;
    float oil_pressure = 0, oil_temp = 0, water_temp = 0, battery = 0;
    bool fuel_warn = false, adblue_warn = false, oil_warn = false, water_warn = false, batt_warn = false;

    // luzes e cabine
    bool lblinker = false, rblinker = false, hazard = false;
    bool light_lblinker = false, light_rblinker = false;
    bool light_parking = false, light_low = false, light_high = false;
    scs_u32_t aux_front = 0, aux_roof = 0;
    bool beacon = false, brake_light = false, reverse_light = false, wipers = false;
    float backlight = 0;

    // eixos
    bool diff_lock = false, lift_axle = false, lift_axle_ind = false;
    bool trailer_lift_axle = false, trailer_lift_axle_ind = false;

    // navegação
    float nav_distance = 0, nav_time = 0, nav_limit = 0;

    // desgaste
    float wear_engine = 0, wear_transmission = 0, wear_cabin = 0, wear_chassis = 0, wear_wheels = 0;
    float trailer_wear_body = 0, trailer_wear_chassis = 0, trailer_wear_wheels = 0;
    float cargo_damage = 0;
    bool trailer_connected = false;

    // configuração do caminhão
    std::string truck_brand, truck_name, truck_plate;
    float fuel_capacity = 0, adblue_capacity = 0, rpm_limit = 0;
    scs_u32_t gears_forward = 0, gears_reverse = 0, retarder_steps = 0;
    bool has_truck = false;

    // reboque (índice 0)
    std::string trailer_name, trailer_brand, trailer_body;

    // entrega
    bool has_job = false, cargo_loaded = false, special_job = false;
    std::string cargo, source_city, source_company, dest_city, dest_company, job_market;
    float cargo_mass = 0;
    scs_u64_t income = 0;
    scs_u32_t delivery_time = 0, planned_km = 0;

    // último acontecimento (entrega, multa, pedágio, balsa, trem, cancelamento)
    unsigned event_seq = 0;
    std::string event_id, event_detail;
    long long event_amount = 0;
};

static Telemetry T;
static std::string game_id = "?";
static std::string game_name = "?";
static unsigned game_version = 0;
static bool telemetry_active = false;
static bool input_active = false;

// ============================================================================ JSON

struct Json {
    std::string s;
    bool first = true;
    void open() { s += '{'; first = true; }
    void close() { s += '}'; first = false; }
    void key(const char *k) {
        if (!first) s += ',';
        first = false;
        s += '"';
        s += k;
        s += "\":";
    }
    void str(const char *k, const std::string &v) {
        key(k);
        s += '"';
        for (unsigned char c : v) {
            if (c == '"' || c == '\\') { s += '\\'; s += (char)c; }
            else if (c < 0x20) { char b[8]; snprintf(b, sizeof(b), "\\u%04x", c); s += b; }
            else s += (char)c;
        }
        s += '"';
    }
    void num(const char *k, double v) {
        key(k);
        if (v != v || v > 1e15 || v < -1e15) { s += "null"; return; }
        char b[48];
        snprintf(b, sizeof(b), "%.4g", v);
        // %.4g pode cortar odômetro e dinheiro: inteiros grandes vão sem expoente
        if (strchr(b, 'e')) snprintf(b, sizeof(b), "%.0f", v);
        s += b;
    }
    void integer(const char *k, long long v) { key(k); s += std::to_string(v); }
    void boolean(const char *k, bool v) { key(k); s += v ? "true" : "false"; }
    void obj(const char *k) { key(k); s += '{'; first = true; }
    void end() { s += '}'; first = false; }
};

static std::string build_state_json() {
    Json j;
    j.open();
    j.str("t", "state");
    j.boolean("paused", T.paused);
    j.integer("gameTime", T.game_time);
    j.integer("restStop", T.rest_stop);

    j.obj("truck");
    j.boolean("present", T.has_truck);
    j.str("brand", T.truck_brand);
    j.str("name", T.truck_name);
    j.str("plate", T.truck_plate);
    j.num("speed", T.speed);
    j.num("rpm", T.rpm);
    j.num("rpmLimit", T.rpm_limit);
    j.integer("gear", T.gear);
    j.integer("displayedGear", T.dgear);
    j.integer("gearsForward", T.gears_forward);
    j.integer("gearsReverse", T.gears_reverse);
    j.num("cruise", T.cruise);
    j.num("odometer", T.odometer);
    j.boolean("engine", T.engine);
    j.boolean("electric", T.electric);
    j.boolean("parkingBrake", T.parking);
    j.boolean("motorBrake", T.motor_brake);
    j.integer("retarder", T.retarder);
    j.integer("retarderSteps", T.retarder_steps);
    j.num("air", T.air);
    j.boolean("airWarning", T.air_warn);
    j.boolean("airEmergency", T.air_emerg);
    j.num("brakeTemp", T.brake_temp);
    j.num("fuel", T.fuel);
    j.num("fuelCapacity", T.fuel_capacity);
    j.num("fuelRange", T.fuel_range);
    j.num("fuelAvg", T.fuel_avg);
    j.boolean("fuelWarning", T.fuel_warn);
    j.num("adblue", T.adblue);
    j.num("adblueCapacity", T.adblue_capacity);
    j.boolean("adblueWarning", T.adblue_warn);
    j.num("oilPressure", T.oil_pressure);
    j.boolean("oilWarning", T.oil_warn);
    j.num("oilTemp", T.oil_temp);
    j.num("waterTemp", T.water_temp);
    j.boolean("waterWarning", T.water_warn);
    j.num("battery", T.battery);
    j.boolean("batteryWarning", T.batt_warn);
    j.boolean("lblinker", T.lblinker);
    j.boolean("rblinker", T.rblinker);
    j.boolean("lblinkerLight", T.light_lblinker);
    j.boolean("rblinkerLight", T.light_rblinker);
    j.boolean("hazard", T.hazard);
    j.boolean("parkingLight", T.light_parking);
    j.boolean("lowBeam", T.light_low);
    j.boolean("highBeam", T.light_high);
    j.integer("auxFront", T.aux_front);
    j.integer("auxRoof", T.aux_roof);
    j.boolean("beacon", T.beacon);
    j.boolean("brakeLight", T.brake_light);
    j.boolean("reverseLight", T.reverse_light);
    j.boolean("wipers", T.wipers);
    j.num("backlight", T.backlight);
    j.boolean("diffLock", T.diff_lock);
    j.boolean("liftAxle", T.lift_axle);
    j.boolean("liftAxleIndicator", T.lift_axle_ind);
    j.boolean("trailerLiftAxle", T.trailer_lift_axle);
    j.boolean("trailerLiftAxleIndicator", T.trailer_lift_axle_ind);
    j.num("wearEngine", T.wear_engine);
    j.num("wearTransmission", T.wear_transmission);
    j.num("wearCabin", T.wear_cabin);
    j.num("wearChassis", T.wear_chassis);
    j.num("wearWheels", T.wear_wheels);
    j.end();

    j.obj("nav");
    j.num("distance", T.nav_distance);
    j.num("time", T.nav_time);
    j.num("speedLimit", T.nav_limit);
    j.end();

    j.obj("trailer");
    j.boolean("connected", T.trailer_connected);
    j.str("name", T.trailer_name);
    j.str("brand", T.trailer_brand);
    j.str("body", T.trailer_body);
    j.num("wearBody", T.trailer_wear_body);
    j.num("wearChassis", T.trailer_wear_chassis);
    j.num("wearWheels", T.trailer_wear_wheels);
    j.end();

    j.obj("job");
    j.boolean("active", T.has_job);
    j.str("cargo", T.cargo);
    j.num("cargoMass", T.cargo_mass);
    j.boolean("cargoLoaded", T.cargo_loaded);
    j.num("cargoDamage", T.cargo_damage);
    j.str("sourceCity", T.source_city);
    j.str("sourceCompany", T.source_company);
    j.str("destinationCity", T.dest_city);
    j.str("destinationCompany", T.dest_company);
    j.integer("income", (long long)T.income);
    j.integer("deliveryTime", T.delivery_time);
    j.integer("plannedKm", T.planned_km);
    j.str("market", T.job_market);
    j.boolean("special", T.special_job);
    j.end();

    j.obj("event");
    j.integer("seq", T.event_seq);
    j.str("id", T.event_id);
    j.str("detail", T.event_detail);
    j.integer("amount", T.event_amount);
    j.end();

    j.close();
    j.s += '\n';
    return j.s;
}

static std::string build_info_json() {
    Json j;
    j.open();
    j.str("t", "info");
    j.str("bridge", BRIDGE_VERSION);
    j.str("game", game_id);
    j.str("gameName", game_name);
    j.integer("telemetryVersion", game_version);
    j.boolean("telemetry", telemetry_active);
    j.boolean("input", input_active);
    j.key("commands");
    j.s += '[';
    for (unsigned i = 0; i < COMMAND_COUNT; ++i) {
        if (i) j.s += ',';
        j.s += '"';
        j.s += COMMANDS[i];
        j.s += '"';
    }
    j.s += ']';
    j.close();
    j.s += '\n';
    return j.s;
}

// ============================================================================ rede

struct PendingInput {
    int index;
    bool value;
};

static std::mutex shared_mutex;            // protege tudo abaixo
static std::string shared_state;           // último JSON de estado
static std::string shared_info;            // JSON de info
static unsigned shared_state_seq = 0;      // muda quando o estado muda
static std::deque<PendingInput> input_queue;

static pthread_t server_thread;
static std::atomic<bool> server_running(false);
static int wake_pipe[2] = {-1, -1};
static int server_refs = 0;                 // telemetria e entrada ligam/desligam o servidor juntos

static void publish_state(bool force_info) {
    std::string state = build_state_json();
    std::string info = force_info ? build_info_json() : std::string();
    {
        std::lock_guard<std::mutex> lock(shared_mutex);
        if (state != shared_state) {
            shared_state.swap(state);
            ++shared_state_seq;
        }
        if (force_info) shared_info.swap(info);
    }
    if (wake_pipe[1] >= 0) {
        char c = 1;
        (void)!write(wake_pipe[1], &c, 1);
    }
}

static void enqueue_command(const std::string &verb, const std::string &name) {
    const int idx = command_index(name.c_str());
    if (idx < 0) return;
    std::lock_guard<std::mutex> lock(shared_mutex);
    if (input_queue.size() > 256) return; // proteção contra cliente enlouquecido
    if (verb == "down") input_queue.push_back({idx, true});
    else if (verb == "up") input_queue.push_back({idx, false});
    else if (verb == "tap") {
        input_queue.push_back({idx, true});
        input_queue.push_back({idx, false});
    }
}

struct Client {
    int fd;
    std::string in;
    std::string out;
    unsigned sent_seq;
};

static void handle_line(Client &c, const std::string &line) {
    const size_t sp = line.find(' ');
    const std::string verb = line.substr(0, sp);
    const std::string arg = sp == std::string::npos ? std::string() : line.substr(sp + 1);
    if (verb == "ping") {
        c.out += "{\"t\":\"pong\"}\n";
    } else if (verb == "down" || verb == "up" || verb == "tap") {
        enqueue_command(verb, arg);
    } else if (verb == "info") {
        std::lock_guard<std::mutex> lock(shared_mutex);
        c.out += shared_info;
    }
}

static int server_port() {
    const char *env = getenv("ASTRONAUTA_ETS2_PORT");
    const int p = env ? atoi(env) : 0;
    return p > 0 && p < 65536 ? p : DEFAULT_PORT;
}

static void *server_main(void *) {
    signal(SIGPIPE, SIG_IGN);
    const int port = server_port();
    int listener = -1;
    std::vector<Client> clients;
    time_t last_bind_try = 0;

    while (server_running.load()) {
        // Tenta abrir a porta (de novo, se outra cópia do jogo estava com ela).
        if (listener < 0 && time(NULL) - last_bind_try >= 2) {
            last_bind_try = time(NULL);
            listener = socket(AF_INET, SOCK_STREAM, 0);
            if (listener >= 0) {
                int yes = 1;
                setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));
                sockaddr_in addr;
                memset(&addr, 0, sizeof(addr));
                addr.sin_family = AF_INET;
                addr.sin_port = htons((uint16_t)port);
                addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK); // só a própria máquina
                if (bind(listener, (sockaddr *)&addr, sizeof(addr)) != 0 || listen(listener, 8) != 0) {
                    close(listener);
                    listener = -1;
                } else {
                    fcntl(listener, F_SETFL, O_NONBLOCK);
                }
            }
        }

        std::vector<pollfd> fds;
        fds.push_back({wake_pipe[0], POLLIN, 0});
        if (listener >= 0) fds.push_back({listener, POLLIN, 0});
        const size_t base = fds.size();
        for (auto &c : clients) fds.push_back({c.fd, (short)(POLLIN | (c.out.empty() ? 0 : POLLOUT)), 0});

        poll(fds.data(), fds.size(), 250);

        if (fds[0].revents & POLLIN) {
            char buf[64];
            while (read(wake_pipe[0], buf, sizeof(buf)) > 0) {}
        }

        if (listener >= 0 && (fds[1].revents & POLLIN)) {
            for (;;) {
                int fd = accept(listener, NULL, NULL);
                if (fd < 0) break;
                fcntl(fd, F_SETFL, O_NONBLOCK);
                int yes = 1;
                setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &yes, sizeof(yes));
                setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &yes, sizeof(yes));
                Client c{fd, std::string(), std::string(), 0};
                {
                    std::lock_guard<std::mutex> lock(shared_mutex);
                    c.out = shared_info + shared_state;
                    c.sent_seq = shared_state_seq;
                }
                if (clients.size() < 8) clients.push_back(c);
                else close(fd);
            }
        }

        std::vector<size_t> dead;
        for (size_t i = 0; i < clients.size(); ++i) {
            Client &c = clients[i];
            const short re = (base + i) < fds.size() ? fds[base + i].revents : 0;
            if (re & (POLLERR | POLLHUP | POLLNVAL)) { dead.push_back(i); continue; }
            if (re & POLLIN) {
                char buf[1024];
                const ssize_t n = recv(c.fd, buf, sizeof(buf), 0);
                if (n <= 0) { dead.push_back(i); continue; }
                c.in.append(buf, (size_t)n);
                if (c.in.size() > 65536) { dead.push_back(i); continue; }
                size_t nl;
                while ((nl = c.in.find('\n')) != std::string::npos) {
                    std::string line = c.in.substr(0, nl);
                    c.in.erase(0, nl + 1);
                    while (!line.empty() && (line.back() == '\r' || line.back() == ' ')) line.pop_back();
                    if (!line.empty()) handle_line(c, line);
                }
            }
            {
                std::lock_guard<std::mutex> lock(shared_mutex);
                if (c.sent_seq != shared_state_seq) {
                    // cliente lento: descarta estado velho, manda só o mais novo
                    if (c.out.size() > 262144) c.out.clear();
                    c.out += shared_state;
                    c.sent_seq = shared_state_seq;
                }
            }
            if (!c.out.empty()) {
                const ssize_t n = send(c.fd, c.out.data(), c.out.size(), 0);
                if (n > 0) c.out.erase(0, (size_t)n);
                else if (n < 0 && errno != EAGAIN && errno != EWOULDBLOCK) { dead.push_back(i); continue; }
            }
        }
        for (size_t k = dead.size(); k-- > 0;) {
            close(clients[dead[k]].fd);
            clients.erase(clients.begin() + (long)dead[k]);
        }
    }

    for (auto &c : clients) close(c.fd);
    if (listener >= 0) close(listener);
    return NULL;
}

static bool server_start() {
    if (server_refs++ > 0) return true;
    if (pipe(wake_pipe) != 0) { server_refs--; return false; }
    fcntl(wake_pipe[0], F_SETFL, O_NONBLOCK);
    fcntl(wake_pipe[1], F_SETFL, O_NONBLOCK);
    server_running = true;
    if (pthread_create(&server_thread, NULL, server_main, NULL) != 0) {
        server_running = false;
        close(wake_pipe[0]);
        close(wake_pipe[1]);
        wake_pipe[0] = wake_pipe[1] = -1;
        server_refs--;
        return false;
    }
    blog(SCS_LOG_TYPE_message, "ponte %s ouvindo em 127.0.0.1:%d", BRIDGE_VERSION, server_port());
    return true;
}

static void server_stop() {
    if (server_refs <= 0 || --server_refs > 0) return;
    server_running = false;
    char c = 1;
    (void)!write(wake_pipe[1], &c, 1);
    pthread_join(server_thread, NULL);
    close(wake_pipe[0]);
    close(wake_pipe[1]);
    wake_pipe[0] = wake_pipe[1] = -1;
    std::lock_guard<std::mutex> lock(shared_mutex);
    input_queue.clear();
}

// ============================================================================ telemetria

static double now_seconds() {
    timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec + ts.tv_nsec / 1e9;
}

static double last_publish = 0;

SCSAPI_VOID store_float(const scs_string_t, const scs_u32_t, const scs_value_t *const v, const scs_context_t ctx) {
    *static_cast<float *>(ctx) = v ? v->value_float.value : 0.0f;
}
SCSAPI_VOID store_bool(const scs_string_t, const scs_u32_t, const scs_value_t *const v, const scs_context_t ctx) {
    *static_cast<bool *>(ctx) = v ? v->value_bool.value != 0 : false;
}
SCSAPI_VOID store_u32(const scs_string_t, const scs_u32_t, const scs_value_t *const v, const scs_context_t ctx) {
    *static_cast<scs_u32_t *>(ctx) = v ? v->value_u32.value : 0;
}
SCSAPI_VOID store_s32(const scs_string_t, const scs_u32_t, const scs_value_t *const v, const scs_context_t ctx) {
    *static_cast<scs_s32_t *>(ctx) = v ? v->value_s32.value : 0;
}

static std::string attr_string(const scs_named_value_t &a) {
    return a.value.type == SCS_VALUE_TYPE_string && a.value.value_string.value ? a.value.value_string.value : "";
}
static double attr_number(const scs_named_value_t &a) {
    switch (a.value.type) {
    case SCS_VALUE_TYPE_float: return a.value.value_float.value;
    case SCS_VALUE_TYPE_double: return a.value.value_double.value;
    case SCS_VALUE_TYPE_u32: return a.value.value_u32.value;
    case SCS_VALUE_TYPE_s32: return a.value.value_s32.value;
    case SCS_VALUE_TYPE_u64: return (double)a.value.value_u64.value;
    case SCS_VALUE_TYPE_s64: return (double)a.value.value_s64.value;
    case SCS_VALUE_TYPE_bool: return a.value.value_bool.value ? 1 : 0;
    default: return 0;
    }
}
static bool is(const scs_named_value_t &a, const char *name) { return strcmp(a.name, name) == 0; }

SCSAPI_VOID on_configuration(const scs_event_t, const void *const info, const scs_context_t) {
    const scs_telemetry_configuration_t *cfg = static_cast<const scs_telemetry_configuration_t *>(info);
    const char *id = cfg->id;

    if (strcmp(id, SCS_TELEMETRY_CONFIG_truck) == 0) {
        T.has_truck = false;
        T.truck_brand.clear(); T.truck_name.clear(); T.truck_plate.clear();
        T.fuel_capacity = T.adblue_capacity = T.rpm_limit = 0;
        T.gears_forward = T.gears_reverse = T.retarder_steps = 0;
        for (const scs_named_value_t *a = cfg->attributes; a->name; ++a) {
            if (a->index != SCS_U32_NIL) continue;
            T.has_truck = true;
            if (is(*a, SCS_TELEMETRY_CONFIG_ATTRIBUTE_brand)) T.truck_brand = attr_string(*a);
            else if (is(*a, SCS_TELEMETRY_CONFIG_ATTRIBUTE_name)) T.truck_name = attr_string(*a);
            else if (is(*a, SCS_TELEMETRY_CONFIG_ATTRIBUTE_license_plate)) T.truck_plate = attr_string(*a);
            else if (is(*a, SCS_TELEMETRY_CONFIG_ATTRIBUTE_fuel_capacity)) T.fuel_capacity = (float)attr_number(*a);
            else if (is(*a, SCS_TELEMETRY_CONFIG_ATTRIBUTE_adblue_capacity)) T.adblue_capacity = (float)attr_number(*a);
            else if (is(*a, SCS_TELEMETRY_CONFIG_ATTRIBUTE_rpm_limit)) T.rpm_limit = (float)attr_number(*a);
            else if (is(*a, SCS_TELEMETRY_CONFIG_ATTRIBUTE_forward_gear_count)) T.gears_forward = (scs_u32_t)attr_number(*a);
            else if (is(*a, SCS_TELEMETRY_CONFIG_ATTRIBUTE_reverse_gear_count)) T.gears_reverse = (scs_u32_t)attr_number(*a);
            else if (is(*a, SCS_TELEMETRY_CONFIG_ATTRIBUTE_retarder_step_count)) T.retarder_steps = (scs_u32_t)attr_number(*a);
        }
    } else if (strcmp(id, SCS_TELEMETRY_CONFIG_trailer) == 0 || strcmp(id, "trailer.0") == 0) {
        T.trailer_name.clear(); T.trailer_brand.clear(); T.trailer_body.clear();
        for (const scs_named_value_t *a = cfg->attributes; a->name; ++a) {
            if (a->index != SCS_U32_NIL) continue;
            if (is(*a, SCS_TELEMETRY_CONFIG_ATTRIBUTE_name)) T.trailer_name = attr_string(*a);
            else if (is(*a, SCS_TELEMETRY_CONFIG_ATTRIBUTE_brand)) T.trailer_brand = attr_string(*a);
            else if (is(*a, SCS_TELEMETRY_CONFIG_ATTRIBUTE_body_type)) T.trailer_body = attr_string(*a);
        }
    } else if (strcmp(id, SCS_TELEMETRY_CONFIG_job) == 0) {
        T.has_job = false;
        T.cargo.clear(); T.source_city.clear(); T.source_company.clear();
        T.dest_city.clear(); T.dest_company.clear(); T.job_market.clear();
        T.cargo_mass = 0; T.income = 0; T.delivery_time = 0; T.planned_km = 0;
        T.cargo_loaded = false; T.special_job = false;
        for (const scs_named_value_t *a = cfg->attributes; a->name; ++a) {
            if (a->index != SCS_U32_NIL) continue;
            T.has_job = true;
            if (is(*a, SCS_TELEMETRY_CONFIG_ATTRIBUTE_cargo)) T.cargo = attr_string(*a);
            else if (is(*a, SCS_TELEMETRY_CONFIG_ATTRIBUTE_cargo_mass)) T.cargo_mass = (float)attr_number(*a);
            else if (is(*a, SCS_TELEMETRY_CONFIG_ATTRIBUTE_source_city)) T.source_city = attr_string(*a);
            else if (is(*a, SCS_TELEMETRY_CONFIG_ATTRIBUTE_source_company)) T.source_company = attr_string(*a);
            else if (is(*a, SCS_TELEMETRY_CONFIG_ATTRIBUTE_destination_city)) T.dest_city = attr_string(*a);
            else if (is(*a, SCS_TELEMETRY_CONFIG_ATTRIBUTE_destination_company)) T.dest_company = attr_string(*a);
            else if (is(*a, SCS_TELEMETRY_CONFIG_ATTRIBUTE_income)) T.income = (scs_u64_t)attr_number(*a);
            else if (is(*a, SCS_TELEMETRY_CONFIG_ATTRIBUTE_delivery_time)) T.delivery_time = (scs_u32_t)attr_number(*a);
            else if (is(*a, SCS_TELEMETRY_CONFIG_ATTRIBUTE_planned_distance_km)) T.planned_km = (scs_u32_t)attr_number(*a);
            else if (is(*a, SCS_TELEMETRY_CONFIG_ATTRIBUTE_is_cargo_loaded)) T.cargo_loaded = attr_number(*a) != 0;
            else if (is(*a, SCS_TELEMETRY_CONFIG_ATTRIBUTE_job_market)) T.job_market = attr_string(*a);
            else if (is(*a, SCS_TELEMETRY_CONFIG_ATTRIBUTE_special_job)) T.special_job = attr_number(*a) != 0;
        }
    }
    publish_state(false);
}

SCSAPI_VOID on_gameplay(const scs_event_t, const void *const info, const scs_context_t) {
    const scs_telemetry_gameplay_event_t *ev = static_cast<const scs_telemetry_gameplay_event_t *>(info);
    T.event_id = ev->id ? ev->id : "";
    T.event_detail.clear();
    T.event_amount = 0;
    for (const scs_named_value_t *a = ev->attributes; a && a->name; ++a) {
        if (is(*a, SCS_TELEMETRY_GAMEPLAY_EVENT_ATTRIBUTE_revenue) ||
            is(*a, SCS_TELEMETRY_GAMEPLAY_EVENT_ATTRIBUTE_fine_amount) ||
            is(*a, SCS_TELEMETRY_GAMEPLAY_EVENT_ATTRIBUTE_pay_amount) ||
            is(*a, SCS_TELEMETRY_GAMEPLAY_EVENT_ATTRIBUTE_cancel_penalty)) {
            T.event_amount = (long long)attr_number(*a);
        } else if (is(*a, SCS_TELEMETRY_GAMEPLAY_EVENT_ATTRIBUTE_fine_offence) ||
                   is(*a, SCS_TELEMETRY_GAMEPLAY_EVENT_ATTRIBUTE_target_name)) {
            T.event_detail = attr_string(*a);
        }
    }
    if (strcmp(T.event_id.c_str(), SCS_TELEMETRY_GAMEPLAY_EVENT_job_delivered) == 0 ||
        strcmp(T.event_id.c_str(), SCS_TELEMETRY_GAMEPLAY_EVENT_job_cancelled) == 0) {
        T.has_job = false;
    }
    ++T.event_seq;
    publish_state(false);
}

SCSAPI_VOID on_pause(const scs_event_t event, const void *const, const scs_context_t) {
    T.paused = event == SCS_TELEMETRY_EVENT_paused;
    publish_state(false);
}

SCSAPI_VOID on_frame_end(const scs_event_t, const void *const, const scs_context_t) {
    // Até 10 atualizações por segundo é mais do que a tela do Stream Deck acompanha.
    const double now = now_seconds();
    if (now - last_publish < 0.1) return;
    last_publish = now;
    publish_state(false);
}

static scs_telemetry_register_for_channel_t reg_channel = NULL;

static void ch(const char *name, scs_value_type_t type, void *target) {
    scs_telemetry_channel_callback_t cb = NULL;
    switch (type) {
    case SCS_VALUE_TYPE_float: cb = store_float; break;
    case SCS_VALUE_TYPE_bool: cb = store_bool; break;
    case SCS_VALUE_TYPE_u32: cb = store_u32; break;
    case SCS_VALUE_TYPE_s32: cb = store_s32; break;
    default: return;
    }
    // Canal que não existe nesta versão do jogo só fica no valor padrão.
    reg_channel(name, SCS_U32_NIL, type, SCS_TELEMETRY_CHANNEL_FLAG_none, cb, target);
}

static void ch_trailer(const char *suffix, scs_value_type_t type, void *target) {
    // Desde a telemetria 1.14 os canais de reboque vêm como "trailer.0.<canal>"; antes, "trailer.<canal>".
    std::string name = std::string("trailer.0.") + suffix;
    scs_telemetry_channel_callback_t cb = type == SCS_VALUE_TYPE_bool ? store_bool : store_float;
    if (reg_channel(name.c_str(), SCS_U32_NIL, type, SCS_TELEMETRY_CHANNEL_FLAG_none, cb, target) != SCS_RESULT_ok) {
        name = std::string("trailer.") + suffix;
        reg_channel(name.c_str(), SCS_U32_NIL, type, SCS_TELEMETRY_CHANNEL_FLAG_none, cb, target);
    }
}

SCSAPI_RESULT scs_telemetry_init(const scs_u32_t version, const scs_telemetry_init_params_t *const params) {
    if (version != SCS_TELEMETRY_VERSION_1_01 && version != SCS_TELEMETRY_VERSION_1_00) return SCS_RESULT_unsupported;
    const scs_telemetry_init_params_v101_t *p = static_cast<const scs_telemetry_init_params_v101_t *>(params);
    game_log = p->common.log;
    game_id = p->common.game_id ? p->common.game_id : "?";
    game_name = p->common.game_name ? p->common.game_name : "?";
    game_version = p->common.game_version;
    reg_channel = p->register_for_channel;

    T = Telemetry();
    bool ok = p->register_for_event(SCS_TELEMETRY_EVENT_frame_end, on_frame_end, NULL) == SCS_RESULT_ok &&
              p->register_for_event(SCS_TELEMETRY_EVENT_paused, on_pause, NULL) == SCS_RESULT_ok &&
              p->register_for_event(SCS_TELEMETRY_EVENT_started, on_pause, NULL) == SCS_RESULT_ok;
    if (!ok) {
        blog(SCS_LOG_TYPE_error, "nao consegui registrar os eventos basicos");
        return SCS_RESULT_generic_error;
    }
    p->register_for_event(SCS_TELEMETRY_EVENT_configuration, on_configuration, NULL);
    p->register_for_event(SCS_TELEMETRY_EVENT_gameplay, on_gameplay, NULL);

    ch(SCS_TELEMETRY_CHANNEL_game_time, SCS_VALUE_TYPE_u32, &T.game_time);
    ch(SCS_TELEMETRY_CHANNEL_next_rest_stop, SCS_VALUE_TYPE_s32, &T.rest_stop);
    ch(SCS_TELEMETRY_CHANNEL_local_scale, SCS_VALUE_TYPE_float, &T.local_scale);

    ch(SCS_TELEMETRY_TRUCK_CHANNEL_speed, SCS_VALUE_TYPE_float, &T.speed);
    ch(SCS_TELEMETRY_TRUCK_CHANNEL_engine_rpm, SCS_VALUE_TYPE_float, &T.rpm);
    ch(SCS_TELEMETRY_TRUCK_CHANNEL_engine_gear, SCS_VALUE_TYPE_s32, &T.gear);
    ch(SCS_TELEMETRY_TRUCK_CHANNEL_displayed_gear, SCS_VALUE_TYPE_s32, &T.dgear);
    ch(SCS_TELEMETRY_TRUCK_CHANNEL_cruise_control, SCS_VALUE_TYPE_float, &T.cruise);
    ch(SCS_TELEMETRY_TRUCK_CHANNEL_odometer, SCS_VALUE_TYPE_float, &T.odometer);
    ch(SCS_TELEMETRY_TRUCK_CHANNEL_engine_enabled, SCS_VALUE_TYPE_bool, &T.engine);
    ch(SCS_TELEMETRY_TRUCK_CHANNEL_electric_enabled, SCS_VALUE_TYPE_bool, &T.electric);

    ch(SCS_TELEMETRY_TRUCK_CHANNEL_parking_brake, SCS_VALUE_TYPE_bool, &T.parking);
    ch(SCS_TELEMETRY_TRUCK_CHANNEL_motor_brake, SCS_VALUE_TYPE_bool, &T.motor_brake);
    ch(SCS_TELEMETRY_TRUCK_CHANNEL_retarder_level, SCS_VALUE_TYPE_u32, &T.retarder);
    ch(SCS_TELEMETRY_TRUCK_CHANNEL_brake_air_pressure, SCS_VALUE_TYPE_float, &T.air);
    ch(SCS_TELEMETRY_TRUCK_CHANNEL_brake_air_pressure_warning, SCS_VALUE_TYPE_bool, &T.air_warn);
    ch(SCS_TELEMETRY_TRUCK_CHANNEL_brake_air_pressure_emergency, SCS_VALUE_TYPE_bool, &T.air_emerg);
    ch(SCS_TELEMETRY_TRUCK_CHANNEL_brake_temperature, SCS_VALUE_TYPE_float, &T.brake_temp);

    ch(SCS_TELEMETRY_TRUCK_CHANNEL_fuel, SCS_VALUE_TYPE_float, &T.fuel);
    ch(SCS_TELEMETRY_TRUCK_CHANNEL_fuel_warning, SCS_VALUE_TYPE_bool, &T.fuel_warn);
    ch(SCS_TELEMETRY_TRUCK_CHANNEL_fuel_average_consumption, SCS_VALUE_TYPE_float, &T.fuel_avg);
    ch(SCS_TELEMETRY_TRUCK_CHANNEL_fuel_range, SCS_VALUE_TYPE_float, &T.fuel_range);
    ch(SCS_TELEMETRY_TRUCK_CHANNEL_adblue, SCS_VALUE_TYPE_float, &T.adblue);
    ch(SCS_TELEMETRY_TRUCK_CHANNEL_adblue_warning, SCS_VALUE_TYPE_bool, &T.adblue_warn);
    ch(SCS_TELEMETRY_TRUCK_CHANNEL_oil_pressure, SCS_VALUE_TYPE_float, &T.oil_pressure);
    ch(SCS_TELEMETRY_TRUCK_CHANNEL_oil_pressure_warning, SCS_VALUE_TYPE_bool, &T.oil_warn);
    ch(SCS_TELEMETRY_TRUCK_CHANNEL_oil_temperature, SCS_VALUE_TYPE_float, &T.oil_temp);
    ch(SCS_TELEMETRY_TRUCK_CHANNEL_water_temperature, SCS_VALUE_TYPE_float, &T.water_temp);
    ch(SCS_TELEMETRY_TRUCK_CHANNEL_water_temperature_warning, SCS_VALUE_TYPE_bool, &T.water_warn);
    ch(SCS_TELEMETRY_TRUCK_CHANNEL_battery_voltage, SCS_VALUE_TYPE_float, &T.battery);
    ch(SCS_TELEMETRY_TRUCK_CHANNEL_battery_voltage_warning, SCS_VALUE_TYPE_bool, &T.batt_warn);

    ch(SCS_TELEMETRY_TRUCK_CHANNEL_lblinker, SCS_VALUE_TYPE_bool, &T.lblinker);
    ch(SCS_TELEMETRY_TRUCK_CHANNEL_rblinker, SCS_VALUE_TYPE_bool, &T.rblinker);
    ch(SCS_TELEMETRY_TRUCK_CHANNEL_hazard_warning, SCS_VALUE_TYPE_bool, &T.hazard);
    ch(SCS_TELEMETRY_TRUCK_CHANNEL_light_lblinker, SCS_VALUE_TYPE_bool, &T.light_lblinker);
    ch(SCS_TELEMETRY_TRUCK_CHANNEL_light_rblinker, SCS_VALUE_TYPE_bool, &T.light_rblinker);
    ch(SCS_TELEMETRY_TRUCK_CHANNEL_light_parking, SCS_VALUE_TYPE_bool, &T.light_parking);
    ch(SCS_TELEMETRY_TRUCK_CHANNEL_light_low_beam, SCS_VALUE_TYPE_bool, &T.light_low);
    ch(SCS_TELEMETRY_TRUCK_CHANNEL_light_high_beam, SCS_VALUE_TYPE_bool, &T.light_high);
    ch(SCS_TELEMETRY_TRUCK_CHANNEL_light_aux_front, SCS_VALUE_TYPE_u32, &T.aux_front);
    ch(SCS_TELEMETRY_TRUCK_CHANNEL_light_aux_roof, SCS_VALUE_TYPE_u32, &T.aux_roof);
    ch(SCS_TELEMETRY_TRUCK_CHANNEL_light_beacon, SCS_VALUE_TYPE_bool, &T.beacon);
    ch(SCS_TELEMETRY_TRUCK_CHANNEL_light_brake, SCS_VALUE_TYPE_bool, &T.brake_light);
    ch(SCS_TELEMETRY_TRUCK_CHANNEL_light_reverse, SCS_VALUE_TYPE_bool, &T.reverse_light);
    ch(SCS_TELEMETRY_TRUCK_CHANNEL_wipers, SCS_VALUE_TYPE_bool, &T.wipers);
    ch(SCS_TELEMETRY_TRUCK_CHANNEL_dashboard_backlight, SCS_VALUE_TYPE_float, &T.backlight);

    ch(SCS_TELEMETRY_TRUCK_CHANNEL_differential_lock, SCS_VALUE_TYPE_bool, &T.diff_lock);
    ch(SCS_TELEMETRY_TRUCK_CHANNEL_lift_axle, SCS_VALUE_TYPE_bool, &T.lift_axle);
    ch(SCS_TELEMETRY_TRUCK_CHANNEL_lift_axle_indicator, SCS_VALUE_TYPE_bool, &T.lift_axle_ind);
    ch(SCS_TELEMETRY_TRUCK_CHANNEL_trailer_lift_axle, SCS_VALUE_TYPE_bool, &T.trailer_lift_axle);
    ch(SCS_TELEMETRY_TRUCK_CHANNEL_trailer_lift_axle_indicator, SCS_VALUE_TYPE_bool, &T.trailer_lift_axle_ind);

    ch(SCS_TELEMETRY_TRUCK_CHANNEL_navigation_distance, SCS_VALUE_TYPE_float, &T.nav_distance);
    ch(SCS_TELEMETRY_TRUCK_CHANNEL_navigation_time, SCS_VALUE_TYPE_float, &T.nav_time);
    ch(SCS_TELEMETRY_TRUCK_CHANNEL_navigation_speed_limit, SCS_VALUE_TYPE_float, &T.nav_limit);

    ch(SCS_TELEMETRY_TRUCK_CHANNEL_wear_engine, SCS_VALUE_TYPE_float, &T.wear_engine);
    ch(SCS_TELEMETRY_TRUCK_CHANNEL_wear_transmission, SCS_VALUE_TYPE_float, &T.wear_transmission);
    ch(SCS_TELEMETRY_TRUCK_CHANNEL_wear_cabin, SCS_VALUE_TYPE_float, &T.wear_cabin);
    ch(SCS_TELEMETRY_TRUCK_CHANNEL_wear_chassis, SCS_VALUE_TYPE_float, &T.wear_chassis);
    ch(SCS_TELEMETRY_TRUCK_CHANNEL_wear_wheels, SCS_VALUE_TYPE_float, &T.wear_wheels);

    ch(SCS_TELEMETRY_JOB_CHANNEL_cargo_damage, SCS_VALUE_TYPE_float, &T.cargo_damage);
    ch_trailer("connected", SCS_VALUE_TYPE_bool, &T.trailer_connected);
    ch_trailer("wear.body", SCS_VALUE_TYPE_float, &T.trailer_wear_body);
    ch_trailer("wear.chassis", SCS_VALUE_TYPE_float, &T.trailer_wear_chassis);
    ch_trailer("wear.wheels", SCS_VALUE_TYPE_float, &T.trailer_wear_wheels);

    telemetry_active = true;
    T.paused = true; // o jogo manda "started" quando sai da pausa
    server_start();
    publish_state(true);
    blog(SCS_LOG_TYPE_message, "telemetria ligada (%s, versao %u.%u)", game_id.c_str(),
         SCS_GET_MAJOR_VERSION(game_version), SCS_GET_MINOR_VERSION(game_version));
    return SCS_RESULT_ok;
}

SCSAPI_VOID scs_telemetry_shutdown(void) {
    telemetry_active = false;
    reg_channel = NULL;
    server_stop();
    game_log = input_active ? game_log : NULL;
}

// ============================================================================ entrada

static unsigned input_frame = 0;
static unsigned pressed_frame[COMMAND_COUNT];
static bool pressed[COMMAND_COUNT];
static const unsigned MIN_HOLD_FRAMES = 3; // o jogo precisa ver o botão apertado por alguns quadros

SCSAPI_RESULT on_input_event(scs_input_event_t *const event_info, const scs_u32_t flags, const scs_context_t) {
    if (flags & SCS_INPUT_EVENT_CALLBACK_FLAG_first_in_frame) ++input_frame;

    std::lock_guard<std::mutex> lock(shared_mutex);
    for (auto it = input_queue.begin(); it != input_queue.end(); ++it) {
        const int idx = it->index;
        if (!it->value && pressed[idx] && input_frame - pressed_frame[idx] < MIN_HOLD_FRAMES) {
            continue; // soltar cedo demais: o jogo não perceberia o toque
        }
        // Um "apertar" do mesmo botão atrás de um "soltar" pendente espera a vez.
        bool blocked = false;
        for (auto prev = input_queue.begin(); prev != it; ++prev)
            if (prev->index == idx) { blocked = true; break; }
        if (blocked) continue;

        event_info->input_index = (scs_u32_t)idx;
        event_info->value_bool.value = it->value ? 1 : 0;
        if (it->value) pressed_frame[idx] = input_frame;
        pressed[idx] = it->value;
        input_queue.erase(it);
        return SCS_RESULT_ok;
    }
    return SCS_RESULT_not_found;
}

static scs_input_device_input_t device_inputs[COMMAND_COUNT];

/** O jogo desativa o dispositivo quando perde o foco ou abre certos menus: esquece o que estava apertado. */
SCSAPI_VOID on_input_active(const scs_u8_t active, const scs_context_t) {
    if (active) return;
    memset(pressed, 0, sizeof(pressed));
}

SCSAPI_RESULT scs_input_init(const scs_u32_t version, const scs_input_init_params_t *const params) {
    if (version != SCS_INPUT_VERSION_1_00) return SCS_RESULT_unsupported;
    const scs_input_init_params_v100_t *p = static_cast<const scs_input_init_params_v100_t *>(params);
    if (!game_log) game_log = p->common.log;

    memset(pressed, 0, sizeof(pressed));
    memset(pressed_frame, 0, sizeof(pressed_frame));
    for (unsigned i = 0; i < COMMAND_COUNT; ++i) {
        device_inputs[i].name = COMMANDS[i];
        device_inputs[i].display_name = COMMANDS[i];
        device_inputs[i].value_type = SCS_VALUE_TYPE_bool;
    }

    scs_input_device_t device;
    memset(&device, 0, sizeof(device));
    device.name = "astronauta_streamdeck";
    device.display_name = "Astronauta Stream Deck";
    device.type = SCS_INPUT_DEVICE_TYPE_semantical;
    device.input_count = COMMAND_COUNT;
    device.inputs = device_inputs;
    device.input_event_callback = on_input_event;
    device.input_active_callback = on_input_active;
    device.callback_context = NULL;

    if (p->register_device(&device) != SCS_RESULT_ok) {
        blog(SCS_LOG_TYPE_error, "o jogo recusou o dispositivo de entrada");
        return SCS_RESULT_generic_error;
    }
    input_active = true;
    server_start();
    publish_state(true);
    blog(SCS_LOG_TYPE_message, "dispositivo de entrada registrado (%u comandos)", COMMAND_COUNT);
    return SCS_RESULT_ok;
}

SCSAPI_VOID scs_input_shutdown(void) {
    input_active = false;
    server_stop();
}
