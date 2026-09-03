/* ==================================================================
   SALT ENGENHARIA — coluna coríntia em 3D real (WebGL / three.js)
   ==================================================================
   Uma coluna só, um objeto 3D só, uma cena só. O scroll é a única
   entrada: ele controla uma linha do tempo de 7 capítulos (um por
   seção do site) que interpola posição, rotação, inclinação, escala
   e câmera continuamente — nunca corta, nunca reseta, nunca
   teleporta. Rolar para cima refaz a coreografia ao contrário.

   Script clássico (não é módulo ES) de propósito: assim funciona
   também abrindo o index.html direto do disco (file://), onde
   `<script type="module">` e fetch() são bloqueados por CORS. O
   modelo já vem embutido em base64 (coluna-data.js) e é decodificado
   com GLTFLoader.parse(), que não faz nenhuma requisição de rede.
   ================================================================== */
(function () {
  "use strict";

  var canvas = document.getElementById("coluna-canvas");
  if (!canvas || !window.THREE || !window.GLTFLoader || !window.COLUNA_GLB_BASE64) return;

  var THREE = window.THREE;
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var ctx2d = null;
  try { ctx2d = !!(window.WebGLRenderingContext); } catch (e) {}
  if (!ctx2d) return; // sem WebGL: a coluna simplesmente não aparece, o resto do site segue normal

  /* ---------------------------------------------------------------
     1. Cena, câmera, luzes
     --------------------------------------------------------------- */
  var scene = new THREE.Scene();

  var camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.1, 100);
  camera.position.set(0, 0, 6.4);

  var renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  } catch (e) { return; }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;

  // luz quente vindo de cima-esquerda-frente (a mesma direção usada na
  // renderização estática anterior) + preenchimento frio sutil + um
  // toque dourado de aro, para casar com a marca
  var key = new THREE.DirectionalLight(0xfff2e0, 2.1);
  key.position.set(-2.6, 3.4, 3.6);
  scene.add(key);

  var fill = new THREE.HemisphereLight(0x3a4048, 0x0b0b0d, 0.65);
  scene.add(fill);

  var rim = new THREE.DirectionalLight(0xc9962e, 1.15);
  rim.position.set(2.8, -0.6, -2.4);
  scene.add(rim);

  var amb = new THREE.AmbientLight(0xffffff, 0.18);
  scene.add(amb);

  /* ---------------------------------------------------------------
     2. Carrega o modelo (embutido, sem rede) e centraliza/normaliza
     --------------------------------------------------------------- */
  var rig = new THREE.Group();     // grupo que recebe TODA a coreografia
  scene.add(rig);

  var modelo = null;
  var pronto = false;

  function base64ParaArrayBuffer(b64) {
    var bin = atob(b64);
    var len = bin.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  try {
    var buffer = base64ParaArrayBuffer(window.COLUNA_GLB_BASE64);
    var loader = new window.GLTFLoader();
    loader.parse(buffer, "", function (gltf) {
      modelo = gltf.scene;
      modelo.traverse(function (o) {
        if (o.isMesh) {
          o.castShadow = false;
          o.receiveShadow = false;
          if (o.material) {
            o.material.side = THREE.FrontSide;
            o.material.envMapIntensity = 1;
          }
        }
      });

      // centraliza no próprio eixo e normaliza para altura = 2 unidades
      var box = new THREE.Box3().setFromObject(modelo);
      var centro = box.getCenter(new THREE.Vector3());
      var tamanho = box.getSize(new THREE.Vector3());
      var escalaBase = 2 / (tamanho.y || 1);
      modelo.position.set(-centro.x, -centro.y, -centro.z);

      var casco = new THREE.Group();
      casco.add(modelo);
      casco.scale.setScalar(escalaBase);
      rig.add(casco);

      pronto = true;
      canvas.classList.add("pronto");
    }, function (err) {
      // falha ao decodificar: não quebra o site, só não mostra a coluna
      canvas.style.display = "none";
    });
  } catch (e) {
    canvas.style.display = "none";
  }

  /* ---------------------------------------------------------------
     3. Redimensionamento
     --------------------------------------------------------------- */
  function resize() {
    var w = innerWidth, h = innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  window.addEventListener("resize", resize);

  /* ---------------------------------------------------------------
     4. As 7 seções = as 7 janelas da coreografia.
     Medimos onde cada seção começa/termina no documento para que os
     "capítulos" sigam o conteúdo real, não uma fração arbitrária.
     --------------------------------------------------------------- */
  var idsSecoes = ["hero", "processo", "servicos", "obras", "sobre", "contato", "foot"];
  var limites = [];   // 8 pontos (0..1) — início de cada capítulo + fim do último

  function medirCapitulos() {
    var els = idsSecoes.map(function (id) { return document.getElementById(id); }).filter(Boolean);
    if (!els.length) return;
    var total = document.documentElement.scrollHeight - innerHeight;
    if (total <= 0) total = 1;
    limites = els.map(function (el) { return Math.min(1, Math.max(0, el.offsetTop / total)); });
    limites.push(1);
  }
  medirCapitulos();
  window.addEventListener("resize", medirCapitulos);
  window.addEventListener("load", medirCapitulos);

  /* ---------------------------------------------------------------
     5. Os 8 estados-chave (fronteiras dos 7 capítulos).
     Ângulos em graus (convertidos para radianos ao aplicar).
     rotY é CONTÍNUO e crescente — nunca "dá a volta" de repente,
     por isso girar para trás no scroll sempre desfaz suavemente.
     --------------------------------------------------------------- */
  // Escala grande e câmera perto o tempo todo: a coluna precisa preencher
  // a tela em toda seção, nunca virar um objeto pequeno flutuando no
  // vazio. "x" e "z-roll" (tiltZ) fazem o trabalho de composição — nunca
  // fica estática no centro: ora enche a tela pela direita, ora pela
  // esquerda, ora deitada, ora inclinada 45°.
  // KF[i] é a pose de ASSINATURA da seção i+1 — a pose que ela SEGURA
  // (ver SEGURA logo abaixo). rotY sempre crescente, nunca reseta.
  var KF = [
    /* 0 — Seção 1 (hero): grande, à direita, corte no topo — só o
       capitel e o alto do fuste aparecem, preenchendo a tela.        */
    { x: 1.35,  y: -1.55, z: 0,    rotY: 0.05, tiltX: 2,   tiltZ: 3,   scale: 2.35, camX: 0.00,  camY: 0.05,  camZ: 2.05, fov: 44 },
    /* 1 — Seção 2 (processo): DEITADA — o fuste cruza a tela na
       horizontal, de ponta a ponta.                                  */
    { x: 0.00,  y: 0.00,  z: 0.15, rotY: 0.75, tiltX: 4,   tiltZ: 86,  scale: 1.85, camX: 0.00,  camY: -0.05, camZ: 2.25, fov: 44 },
    /* 2 — Seção 3 (serviços): inclinação de 45°, tela cheia — capitel
       e caneluras em close.                                          */
    { x: 0.85,  y: -0.15, z: 0.05, rotY: 1.65, tiltX: 18,  tiltZ: 45,  scale: 1.80, camX: 0.15,  camY: 0.05,  camZ: 2.75, fov: 42 },
    /* 3 — Seção 4 (obras): troca de lado — vai para a ESQUERDA, muda
       de ângulo, sempre em tela cheia.                                */
    { x: -1.30, y: 0.05,  z: 0,    rotY: 2.55, tiltX: -14, tiltZ: 30,  scale: 1.85, camX: -0.15, camY: -0.05, camZ: 2.85, fov: 42 },
    /* 4 — Seção 5 (sobre): mesma ideia da 4 — continua à esquerda,
       ângulo novo.                                                    */
    { x: -0.95, y: -0.30, z: 0.1,  rotY: 3.45, tiltX: 10,  tiltZ: -26, scale: 1.90, camX: -0.10, camY: 0.06,  camZ: 2.75, fov: 43 },
    /* 5 — Seção 6 (contato): giro largo, diagonal dinâmica — o momento
       mais cinético antes do fechamento.                              */
    { x: 0.25,  y: 0.30,  z: -0.05,rotY: 4.35, tiltX: 6,   tiltZ: 66,  scale: 1.85, camX: 0.10,  camY: -0.06, camZ: 2.65, fov: 43 },
    /* 6 — Seção 7 (rodapé), pose de entrada: começa a assentar.       */
    { x: 0.65,  y: -0.10, z: 0,    rotY: 5.05, tiltX: 4,   tiltZ: 14,  scale: 1.80, camX: 0.05,  camY: 0.05,  camZ: 2.95, fov: 41 },
    /* 7 — composição final: grande, majestosa, mas nunca idêntica ao
       início — câmera recua um pouco para revelar mais da peça
       inteira, sem nunca ficar pequena.                               */
    { x: 0.55,  y: 0.05,  z: 0,    rotY: 5.55, tiltX: 2,   tiltZ: -3,  scale: 1.70, camX: 0.02,  camY: 0.08,  camZ: 3.25, fov: 40 }
  ];
  var CHAVES = ["x", "y", "z", "rotY", "tiltX", "tiltZ", "scale", "camX", "camY", "camZ", "fov"];

  function suavizar(t) { return t * t * (3 - 2 * t); } // smoothstep — sem robótica linear

  // cada capítulo SEGURA a pose de KF[cap] (a assinatura visual daquela
  // seção — deitada, 45°, à esquerda...) pela maior parte do scroll, e só
  // faz a virada para a próxima pose no trecho final. Sem isso, a coluna
  // vive perpetuamente "no meio do caminho" entre duas poses e nunca lê
  // como "esta seção é a seção da coluna deitada", por exemplo.
  var SEGURA = 0.56;

  function estadoNoProgresso(p) {
    p = Math.min(1, Math.max(0, p));
    var n = limites.length - 1; // nº de capítulos
    var out = {};
    if (!n) { CHAVES.forEach(function (k) { out[k] = KF[0][k]; }); return out; }

    var cap = 0;
    for (var i = 0; i < n; i++) { if (p >= limites[i]) cap = i; }
    var ini = limites[cap], fim = limites[cap + 1] != null ? limites[cap + 1] : 1;
    var local = fim > ini ? (p - ini) / (fim - ini) : 0;
    local = Math.min(1, Math.max(0, local));
    local = suavizar(Math.min(1, Math.max(0, (local - SEGURA) / (1 - SEGURA))));

    var a = KF[cap] || KF[0], b = KF[cap + 1] || KF[KF.length - 1];
    CHAVES.forEach(function (k) { out[k] = a[k] + (b[k] - a[k]) * local; });
    return out;
  }

  /* ---------------------------------------------------------------
     6. Progresso do scroll → amortecido (spring), nunca instantâneo.
     Isso resolve sozinho quase todos os pedidos de física: rolagem
     rápida "atira" o alvo para longe e a coluna alcança em voo,
     rolagem lenta segue de perto, e nunca há salto — mesmo pulando
     de seção pelo menu.
     --------------------------------------------------------------- */
  var progressoAlvo = 0;
  var progressoAtual = 0;
  var relogio = new THREE.Clock();

  function medirProgresso() {
    var total = document.documentElement.scrollHeight - innerHeight;
    progressoAlvo = total > 0 ? Math.min(1, Math.max(0, window.scrollY / total)) : 0;
  }
  medirProgresso();
  window.addEventListener("scroll", medirProgresso, { passive: true });
  window.addEventListener("resize", medirProgresso);

  /* respiração contínua: nunca fica congelada mesmo com o scroll parado */
  function respiracao(tempo) {
    if (reduced) return { rotY: 0, y: 0, tiltZ: 0 };
    return {
      rotY: Math.sin(tempo * 0.18) * 0.035,
      y: Math.sin(tempo * 0.27 + 1.3) * 0.035,
      tiltZ: Math.sin(tempo * 0.15 + 0.6) * 0.9
    };
  }

  var visivel = true;
  document.addEventListener("visibilitychange", function () { visivel = !document.hidden; });

  function loop() {
    requestAnimationFrame(loop);
    if (!visivel || !pronto) { renderer.render(scene, camera); return; }

    var dt = Math.min(0.05, relogio.getDelta());
    var K = reduced ? 1 : (1 - Math.pow(0.0028, dt)); // amortecimento independente de fps
    progressoAtual += (progressoAlvo - progressoAtual) * K;

    var t = relogio.elapsedTime;
    var e = estadoNoProgresso(progressoAtual);
    var resp = respiracao(t);

    // em telas estreitas (retrato) a largura visível encolhe muito mais
    // rápido que a altura; sem isso os balanços para os lados jogariam a
    // coluna inteira para fora do enquadramento no celular.
    var aspecto = innerWidth / innerHeight;
    var fatorX = Math.min(1, Math.max(0.4, aspecto / 1.4));

    rig.position.set(e.x * fatorX, e.y + resp.y, e.z);
    rig.rotation.set(
      (e.tiltX * Math.PI) / 180,
      e.rotY + resp.rotY,
      ((e.tiltZ + resp.tiltZ) * Math.PI) / 180
    );
    rig.scale.setScalar(e.scale);

    // a câmera fica perto da origem olhando para perto da origem — é o
    // deslocamento do PRÓPRIO OBJETO (x acima) que faz a composição
    // variar de lado a cada capítulo, nunca preso no centro da tela.
    camera.position.set(e.camX, e.camY, e.camZ);
    camera.fov = e.fov;
    camera.updateProjectionMatrix();
    camera.lookAt(0, e.y * 0.3, 0);

    renderer.render(scene, camera);
  }
  requestAnimationFrame(loop);
})();
