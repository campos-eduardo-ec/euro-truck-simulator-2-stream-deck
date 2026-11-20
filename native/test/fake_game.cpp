/**
 * Jogo falso: carrega a ponte como o ETS2 carregaria, simula telemetria e quadros de entrada
 * e confere o caminho completo (TCP -> fila -> callback de entrada; canais -> JSON).
 *
 *   ./test/run.sh
 */
#include <dlfcn.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <arpa/inet.h>
#include <sys/socket.h>
#include <poll.h>
#include <map>
#include <string>
#include <vector>
#include "scssdk_telemetry.h"
#include "scssdk_input.h"
#include "eurotrucks2/scssdk_eut2.h"
#include "eurotrucks2/scssdk_telemetry_eut2.h"
#include "common/scssdk_telemetry_common_configs.h"

static int fails = 0;
#define CHECK(c, msg) do { if (c) printf("  ok   %s\n", msg); else { printf("  FALHA %s\n", msg); ++fails; } } while (0)

struct Chan { scs_value_type_t type; scs_telemetry_channel_callback_t cb; scs_context_t ctx; };
static std::map<std::string, Chan> chans;
static std::map<scs_event_t, std::pair<scs_telemetry_event_callback_t, scs_context_t>> events;
static scs_input_device_t dev;
static std::vector<scs_input_device_input_t> dev_inputs;

SCSAPI_VOID glog(const scs_log_type_t, const scs_string_t m) { printf("  [log] %s\n", m); }
SCSAPI_RESULT reg_event(const scs_event_t e, const scs_telemetry_event_callback_t cb, const scs_context_t ctx) { events[e] = {cb, ctx}; return SCS_RESULT_ok; }
SCSAPI_RESULT unreg_event(const scs_event_t) { return SCS_RESULT_ok; }
SCSAPI_RESULT reg_chan(const scs_string_t n, const scs_u32_t, const scs_value_type_t t, const scs_u32_t, const scs_telemetry_channel_callback_t cb, const scs_context_t ctx) {
    std::string s(n);
    if (s.rfind("trailer.", 0) == 0 && s.rfind("trailer.0.", 0) != 0) return SCS_RESULT_not_found; // jogo novo: só trailer.0.*
    chans[s] = {t, cb, ctx}; return SCS_RESULT_ok;
}
SCSAPI_RESULT unreg_chan(const scs_string_t, const scs_u32_t, const scs_value_type_t) { return SCS_RESULT_ok; }
SCSAPI_RESULT reg_dev(const scs_input_device_t *const d) {
    dev = *d; dev_inputs.assign(d->inputs, d->inputs + d->input_count); dev.inputs = dev_inputs.data(); return SCS_RESULT_ok;
}

static void setf(const char *n, float v) { scs_value_t x; memset(&x,0,sizeof x); x.type=SCS_VALUE_TYPE_float; x.value_float.value=v; auto &c=chans.at(n); c.cb(n,SCS_U32_NIL,&x,c.ctx); }
static void setb(const char *n, bool v) { scs_value_t x; memset(&x,0,sizeof x); x.type=SCS_VALUE_TYPE_bool; x.value_bool.value=v; auto &c=chans.at(n); c.cb(n,SCS_U32_NIL,&x,c.ctx); }
static void fire(scs_event_t e, const void *info) { auto it = events.find(e); if (it != events.end()) it->second.first(e, info, it->second.second); }

static int connect_bridge(int port) {
    for (int i = 0; i < 50; ++i) {
        int fd = socket(AF_INET, SOCK_STREAM, 0);
        sockaddr_in a; memset(&a,0,sizeof a); a.sin_family=AF_INET; a.sin_port=htons(port); a.sin_addr.s_addr=htonl(INADDR_LOOPBACK);
        if (connect(fd,(sockaddr*)&a,sizeof a)==0) return fd;
        close(fd); usleep(50000);
    }
    return -1;
}
static std::string read_some(int fd, int ms) {
    std::string out; char b[65536];
    for (;;) { pollfd p{fd,POLLIN,0}; if (poll(&p,1,ms)<=0) break; ssize_t n=recv(fd,b,sizeof b,0); if (n<=0) break; out.append(b,n); ms=50; }
    return out;
}

/** Um quadro de entrada: chama o callback até ele dizer que acabou. */
static std::vector<std::pair<std::string,bool>> input_frame() {
    std::vector<std::pair<std::string,bool>> got;
    scs_u32_t flags = SCS_INPUT_EVENT_CALLBACK_FLAG_first_in_frame;
    for (;;) {
        scs_input_event_t ev; memset(&ev,0,sizeof ev);
        if (dev.input_event_callback(&ev, flags, dev.callback_context) != SCS_RESULT_ok) break;
        got.push_back({dev_inputs[ev.input_index].name, ev.value_bool.value != 0});
        flags = 0;
    }
    return got;
}

/**
 * Modo servidor: o jogo falso fica rodando, reage aos comandos como o jogo faria (motor liga e
 * desliga, freio de mão, piscas, faróis...) e imprime cada comando recebido em stdout. Usado pelo
 * teste de ponta a ponta do plugin (test/fake_sd_ets2.js).
 */
static int serve(void *h, int seconds) {
    auto tinit = (scs_result_t(*)(scs_u32_t, const scs_telemetry_init_params_t*))dlsym(h,"scs_telemetry_init");
    auto tshut = (void(*)())dlsym(h,"scs_telemetry_shutdown");
    auto iinit = (scs_result_t(*)(scs_u32_t, const scs_input_init_params_t*))dlsym(h,"scs_input_init");
    auto ishut = (void(*)())dlsym(h,"scs_input_shutdown");
    scs_telemetry_init_params_v101_t tp; memset(&tp,0,sizeof tp);
    tp.common.game_name="Euro Truck Simulator 2"; tp.common.game_id=SCS_GAME_ID_EUT2; tp.common.game_version=SCS_TELEMETRY_EUT2_GAME_VERSION_CURRENT; tp.common.log=glog;
    tp.register_for_event=reg_event; tp.unregister_from_event=unreg_event; tp.register_for_channel=reg_chan; tp.unregister_from_channel=unreg_chan;
    scs_input_init_params_v100_t ip; memset(&ip,0,sizeof ip); ip.common = tp.common; ip.register_device=reg_dev;
    if (tinit(SCS_TELEMETRY_VERSION_1_01, &tp)!=SCS_RESULT_ok || iinit(SCS_INPUT_VERSION_1_00, &ip)!=SCS_RESULT_ok) return 3;

    scs_named_value_t truck[4]; memset(truck,0,sizeof truck);
    truck[0].name=SCS_TELEMETRY_CONFIG_ATTRIBUTE_fuel_capacity; truck[0].index=SCS_U32_NIL; truck[0].value.type=SCS_VALUE_TYPE_float; truck[0].value.value_float.value=800;
    truck[1].name=SCS_TELEMETRY_CONFIG_ATTRIBUTE_retarder_step_count; truck[1].index=SCS_U32_NIL; truck[1].value.type=SCS_VALUE_TYPE_u32; truck[1].value.value_u32.value=4;
    truck[2].name=SCS_TELEMETRY_CONFIG_ATTRIBUTE_brand; truck[2].index=SCS_U32_NIL; truck[2].value.type=SCS_VALUE_TYPE_string; truck[2].value.value_string.value="Scania";
    scs_telemetry_configuration_t tc{SCS_TELEMETRY_CONFIG_truck, truck};
    fire(SCS_TELEMETRY_EVENT_configuration, &tc);
    fire(SCS_TELEMETRY_EVENT_started, NULL);

    bool engine=false, parking=true, lbl=false, lights=false; float cruise=0; unsigned ret=0, mode=0;
    setb("truck.engine.enabled", engine); setb("truck.brake.parking", parking); setf("truck.fuel.amount", 600); setf("truck.speed", 20);
    setf("truck.navigation.speed.limit", 80/3.6f);
    printf("PRONTO\n"); fflush(stdout);
    for (int tick = 0; tick < seconds * 60; ++tick) {
        for (auto &e : input_frame()) {
            printf("CMD %s %d\n", e.first.c_str(), e.second ? 1 : 0); fflush(stdout);
            if (!e.second) continue; // reage no apertar
            if (e.first=="engine") { engine=!engine; setb("truck.engine.enabled", engine); }
            else if (e.first=="parkingbrake") { parking=!parking; setb("truck.brake.parking", parking); }
            else if (e.first=="lblinker") { lbl=!lbl; setb("truck.lblinker", lbl); setb("truck.light.lblinker", lbl); }
            else if (e.first=="light") { mode=(mode+1)%3; setb("truck.light.parking", mode>=1); setb("truck.light.beam.low", mode==2); lights=mode>0; }
            else if (e.first=="cruiectrl") { cruise = cruise>0 ? 0 : 20; setf("truck.cruise_control", cruise); }
            else if (e.first=="cruiectrlinc" && cruise>0) { cruise += 1/3.6f; setf("truck.cruise_control", cruise); }
            else if (e.first=="retarderup" && ret<4) { ++ret; scs_value_t x; memset(&x,0,sizeof x); x.type=SCS_VALUE_TYPE_u32; x.value_u32.value=ret; auto &c=chans.at("truck.brake.retarder"); c.cb("truck.brake.retarder",SCS_U32_NIL,&x,c.ctx); }
        }
        if (tick % 3 == 0) fire(SCS_TELEMETRY_EVENT_frame_end, NULL);
        usleep(16000);
    }
    ishut(); tshut();
    return 0;
}

int main(int argc, char **argv) {
    if (argc > 2 && strcmp(argv[2], "--serve") == 0) {
        setvbuf(stdout, NULL, _IOLBF, 0);
        void *h = dlopen(argv[1], RTLD_NOW);
        if (!h) { printf("dlopen: %s\n", dlerror()); return 2; }
        return serve(h, argc > 3 ? atoi(argv[3]) : 20);
    }
    const char *lib = argc > 1 ? argv[1] : "build/astronauta_ets2.dylib";
    setenv("ASTRONAUTA_ETS2_PORT", "47999", 1);
    void *h = dlopen(lib, RTLD_NOW);
    if (!h) { printf("dlopen: %s\n", dlerror()); return 2; }
    auto tinit = (scs_result_t(*)(scs_u32_t, const scs_telemetry_init_params_t*))dlsym(h,"scs_telemetry_init");
    auto tshut = (void(*)())dlsym(h,"scs_telemetry_shutdown");
    auto iinit = (scs_result_t(*)(scs_u32_t, const scs_input_init_params_t*))dlsym(h,"scs_input_init");
    auto ishut = (void(*)())dlsym(h,"scs_input_shutdown");
    CHECK(tinit && tshut && iinit && ishut, "exporta as 4 funcoes do SDK");

    printf("telemetria:\n");
    scs_telemetry_init_params_v101_t tp; memset(&tp,0,sizeof tp);
    tp.common.game_name="Euro Truck Simulator 2"; tp.common.game_id=SCS_GAME_ID_EUT2; tp.common.game_version=SCS_TELEMETRY_EUT2_GAME_VERSION_CURRENT; tp.common.log=glog;
    tp.register_for_event=reg_event; tp.unregister_from_event=unreg_event; tp.register_for_channel=reg_chan; tp.unregister_from_channel=unreg_chan;
    CHECK(tinit(SCS_TELEMETRY_VERSION_1_01, &tp)==SCS_RESULT_ok, "scs_telemetry_init aceita 1.01");
    CHECK(chans.count("truck.speed") && chans.count("truck.light.beacon") && chans.count("trailer.0.connected"), "registra canais do caminhao e trailer.0.*");

    printf("entrada:\n");
    scs_input_init_params_v100_t ip; memset(&ip,0,sizeof ip);
    ip.common = tp.common; ip.register_device=reg_dev;
    CHECK(iinit(SCS_INPUT_VERSION_1_00, &ip)==SCS_RESULT_ok, "scs_input_init registra o dispositivo");
    CHECK(dev.type==SCS_INPUT_DEVICE_TYPE_semantical && dev.input_count>100, "dispositivo semantico com mais de 100 comandos");

    // configuração do caminhão e da entrega
    scs_named_value_t truck[4]; memset(truck,0,sizeof truck);
    truck[0].name=SCS_TELEMETRY_CONFIG_ATTRIBUTE_brand; truck[0].index=SCS_U32_NIL; truck[0].value.type=SCS_VALUE_TYPE_string; truck[0].value.value_string.value="Scania";
    truck[1].name=SCS_TELEMETRY_CONFIG_ATTRIBUTE_fuel_capacity; truck[1].index=SCS_U32_NIL; truck[1].value.type=SCS_VALUE_TYPE_float; truck[1].value.value_float.value=800;
    truck[2].name=SCS_TELEMETRY_CONFIG_ATTRIBUTE_name; truck[2].index=SCS_U32_NIL; truck[2].value.type=SCS_VALUE_TYPE_string; truck[2].value.value_string.value="S \"730\"";
    scs_telemetry_configuration_t tc{SCS_TELEMETRY_CONFIG_truck, truck};
    fire(SCS_TELEMETRY_EVENT_configuration, &tc);
    scs_named_value_t job[3]; memset(job,0,sizeof job);
    job[0].name=SCS_TELEMETRY_CONFIG_ATTRIBUTE_destination_city; job[0].index=SCS_U32_NIL; job[0].value.type=SCS_VALUE_TYPE_string; job[0].value.value_string.value="München";
    job[1].name=SCS_TELEMETRY_CONFIG_ATTRIBUTE_income; job[1].index=SCS_U32_NIL; job[1].value.type=SCS_VALUE_TYPE_u64; job[1].value.value_u64.value=12345678;
    scs_telemetry_configuration_t jc{SCS_TELEMETRY_CONFIG_job, job};
    fire(SCS_TELEMETRY_EVENT_configuration, &jc);

    fire(SCS_TELEMETRY_EVENT_started, NULL);
    setf("truck.speed", 22.5f); setb("truck.engine.enabled", true); setb("truck.brake.parking", false); setf("truck.fuel.amount", 400);
    setb("trailer.0.connected", true);
    usleep(120000);
    fire(SCS_TELEMETRY_EVENT_frame_end, NULL);

    printf("rede:\n");
    int fd = connect_bridge(47999);
    CHECK(fd >= 0, "conecta em 127.0.0.1:47999");
    std::string got = read_some(fd, 1000);
    CHECK(got.find("\"t\":\"info\"") != std::string::npos, "recebe info na conexao");
    CHECK(got.find("\"input\":true") != std::string::npos && got.find("\"telemetry\":true") != std::string::npos, "info diz telemetria e entrada ligadas");
    CHECK(got.find("\"speed\":22.5") != std::string::npos, "estado traz a velocidade");
    CHECK(got.find("\"brand\":\"Scania\"") != std::string::npos, "estado traz a marca do caminhao");
    CHECK(got.find("S \\\"730\\\"") != std::string::npos, "escapa aspas no nome");
    CHECK(got.find("München") != std::string::npos, "mantem acento (UTF-8) no destino");
    CHECK(got.find("\"income\":12345678") != std::string::npos, "renda inteira sem expoente");
    CHECK(got.find("\"paused\":false") != std::string::npos, "sai da pausa com o evento started");
    CHECK(got.find("\"connected\":true") != std::string::npos, "reboque conectado via trailer.0.*");

    // comando: toque no motor, segurar a buzina
    const char *cmds = "tap engine\ndown horn\nnaoexiste x\nping\n";
    send(fd, cmds, strlen(cmds), 0);
    usleep(150000);
    std::string pong = read_some(fd, 300);
    CHECK(pong.find("pong") != std::string::npos, "responde ping");

    auto f1 = input_frame();
    bool engine_down = false, horn_down = false, engine_up_early = false;
    for (auto &e : f1) { if (e.first=="engine" && e.second) engine_down=true; if (e.first=="horn" && e.second) horn_down=true; if (e.first=="engine" && !e.second) engine_up_early=true; }
    CHECK(engine_down && horn_down, "quadro 1: aperta motor e buzina");
    CHECK(!engine_up_early, "quadro 1: nao solta o motor no mesmo quadro");
    auto f2 = input_frame(); auto f3 = input_frame();
    CHECK(f2.empty() && f3.empty(), "quadros 2 e 3: segura o motor apertado");
    auto f4 = input_frame();
    CHECK(f4.size()==1 && f4[0].first=="engine" && !f4[0].second, "quadro 4: solta o motor");
    send(fd, "up horn\n", 8, 0); usleep(100000);
    auto f5 = input_frame();
    CHECK(f5.size()==1 && f5[0].first=="horn" && !f5[0].second, "solta a buzina quando o Stream Deck solta");

    // tap duplo seguido: o segundo aperto espera o primeiro soltar
    send(fd, "tap lblinker\ntap lblinker\n", 26, 0); usleep(100000);
    int downs = 0, ups = 0;
    for (int i = 0; i < 12; ++i) for (auto &e : input_frame()) { if (e.first=="lblinker") (e.second?downs:ups)++; }
    CHECK(downs==2 && ups==2, "dois toques seguidos viram dois apertos completos");

    printf("pausa e evento:\n");
    fire(SCS_TELEMETRY_EVENT_paused, NULL);
    scs_named_value_t fine[3]; memset(fine,0,sizeof fine);
    fine[0].name="fine.offence"; fine[0].index=SCS_U32_NIL; fine[0].value.type=SCS_VALUE_TYPE_string; fine[0].value.value_string.value="speeding";
    fine[1].name="fine.amount"; fine[1].index=SCS_U32_NIL; fine[1].value.type=SCS_VALUE_TYPE_s64; fine[1].value.value_s64.value=500;
    scs_telemetry_gameplay_event_t ge{"player.fined", fine};
    fire(SCS_TELEMETRY_EVENT_gameplay, &ge);
    got = read_some(fd, 600);
    CHECK(got.find("\"paused\":true") != std::string::npos, "avisa pausa");
    CHECK(got.find("\"id\":\"player.fined\"") != std::string::npos && got.find("\"amount\":500") != std::string::npos, "avisa multa com valor");

    printf("desligar:\n");
    ishut(); tshut();
    usleep(100000);
    char b; ssize_t n = recv(fd, &b, 1, 0);
    CHECK(n == 0, "fecha a conexao quando o jogo desliga a ponte");
    close(fd);

    // religar (o jogo pode fazer init/shutdown varias vezes)
    events.clear(); chans.clear();
    CHECK(tinit(SCS_TELEMETRY_VERSION_1_01, &tp)==SCS_RESULT_ok && iinit(SCS_INPUT_VERSION_1_00, &ip)==SCS_RESULT_ok, "liga de novo depois de desligar");
    fd = connect_bridge(47999);
    CHECK(fd >= 0, "aceita conexao de novo");
    if (fd >= 0) close(fd);
    ishut(); tshut();
    dlclose(h);

    printf(fails ? "\n%d FALHA(S)\n" : "\ntudo certo\n", fails);
    return fails ? 1 : 0;
}
