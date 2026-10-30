/**
 * Tahtaya At — Akıllı Tahta ve Telefon Köprüsü
 * Doğrudan WebRTC (PeerJS) + Yerel Sunucu (HTTP Relay) + BroadcastChannel Hibrit İstemci
 */
(function () {
  "use strict";

  // PDF.js worker ayarı
  if (window.pdfjsLib && window.pdfjsLib.GlobalWorkerOptions) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = "assets/vendor/pdf.worker.min.js";
  }

  /* =========================================================
     YARDIMCI FONKSİYONLAR
     ========================================================= */
  function $(id) {
    return document.getElementById(id);
  }

  function rastgeleId(onEk) {
    return (onEk || "id") + "_" + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
  }

  function kodBiçimle(kod) {
    var temiz = String(kod || "").replace(/\D/g, "").slice(0, 6);
    if (temiz.length <= 3) return temiz;
    return temiz.slice(0, 3) + " " + temiz.slice(3);
  }

  function boyutBiçimle(bayt) {
    var b = Number(bayt) || 0;
    if (b < 1024) return b + " B";
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
    return (b / (1024 * 1024)).toFixed(1) + " MB";
  }

  function bildirimGoster(metin, sureMs) {
    var alan = $("bildirim-alani");
    if (!alan) return;
    var el = document.createElement("div");
    el.className = "bildirim";
    el.textContent = metin;
    alan.appendChild(el);
    setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, sureMs || 3200);
  }

  function cihazAdiBul() {
    var ua = navigator.userAgent || "";
    if (/iPhone/i.test(ua)) return "iPhone";
    if (/iPad/i.test(ua)) return "iPad";
    if (/Android/i.test(ua)) {
      var m = ua.match(/Android\s+[\d.]+;\s*([^;)]+)/i);
      if (m && m[1]) {
        var model = m[1].replace(/Build\/.*$/i, "").trim();
        if (model.length > 2 && model.length < 28) return model;
      }
      return "Android Telefon";
    }
    if (/Windows/i.test(ua)) return "Windows Bilgisayar";
    if (/Macintosh/i.test(ua)) return "Mac";
    return "Telefon";
  }

  function dosyaTuruTahmin(ad, mime) {
    if (mime && mime !== "application/octet-stream") return mime;
    var uzanti = String(ad || "").split(".").pop().toLowerCase();
    var harita = {
      pdf: "application/pdf",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      gif: "image/gif",
      webp: "image/webp",
      svg: "image/svg+xml",
      mp4: "video/mp4",
      webm: "video/webm",
      mov: "video/quicktime",
      mp3: "audio/mpeg",
      wav: "audio/wav",
      ogg: "audio/ogg",
      txt: "text/plain",
      md: "text/plain",
      csv: "text/plain",
      json: "application/json",
      html: "text/html"
    };
    return harita[uzanti] || mime || "application/octet-stream";
  }

  function dosyaIkonEtiketi(tur, ad) {
    var t = String(tur || "").toLowerCase();
    var a = String(ad || "").toLowerCase();
    if (t === "baglanti") return "LİNK";
    if (t.indexOf("pdf") !== -1 || a.endsWith(".pdf")) return "PDF";
    if (t.indexOf("image/") === 0) return "FOTO";
    if (t.indexOf("video/") === 0) return "VİDEO";
    if (t.indexOf("audio/") === 0) return "SES";
    if (t.indexOf("text/") === 0 || a.endsWith(".txt") || a.endsWith(".md")) return "METİN";
    return "DOSYA";
  }

  function blobIndir(blob, dosyaAdi) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = dosyaAdi || "dosya";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      if (a.parentNode) a.parentNode.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1500);
  }

  /* =========================================================
     DAHİLİ ZIP OLUŞTURUCU (Sıfır Bağımlılık, CRC32 + Store)
     ========================================================= */
  var CRC_TABLO = (function () {
    var tablo = new Uint32Array(256);
    for (var i = 0; i < 256; i++) {
      var c = i;
      for (var k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      tablo[i] = c >>> 0;
    }
    return tablo;
  })();

  function crc32Hesapla(u8) {
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < u8.length; i++) {
      crc = CRC_TABLO[(crc ^ u8[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  async function zipBlobOlustur(dosyaListesi) {
    var enc = new TextEncoder();
    var yerelParcalar = [];
    var merkeziParcalar = [];
    var ofset = 0;
    var kullanilanAdlar = {};

    for (var i = 0; i < dosyaListesi.length; i++) {
      var d = dosyaListesi[i];
      if (!d.blob) continue;
      var hamAd = (d.ad || ("dosya_" + (i + 1))).replace(/[\\/:*?"<>|]/g, "_");
      if (kullanilanAdlar[hamAd]) {
        var nokta = hamAd.lastIndexOf(".");
        var sayac = ++kullanilanAdlar[hamAd];
        hamAd = nokta > 0
          ? hamAd.slice(0, nokta) + "_" + sayac + hamAd.slice(nokta)
          : hamAd + "_" + sayac;
      } else {
        kullanilanAdlar[hamAd] = 1;
      }

      var adBytes = enc.encode(hamAd);
      var veriBuf = await d.blob.arrayBuffer();
      var veriU8 = new Uint8Array(veriBuf);
      var crc = crc32Hesapla(veriU8);
      var boyut = veriU8.length;

      // Local file header (30 bytes + filename)
      var lh = new ArrayBuffer(30 + adBytes.length);
      var ldv = new DataView(lh);
      ldv.setUint32(0, 0x04034b50, true);
      ldv.setUint16(4, 20, true);
      ldv.setUint16(6, 0x0800, true); // UTF-8
      ldv.setUint16(8, 0, true);      // Store (sıkıştırmasız hızlı)
      ldv.setUint16(10, 0, true);
      ldv.setUint16(12, 0x21, true);
      ldv.setUint32(14, crc, true);
      ldv.setUint32(18, boyut, true);
      ldv.setUint32(22, boyut, true);
      ldv.setUint16(26, adBytes.length, true);
      ldv.setUint16(28, 0, true);
      new Uint8Array(lh, 30).set(adBytes);

      // Central directory header (46 bytes + filename)
      var ch = new ArrayBuffer(46 + adBytes.length);
      var cdv = new DataView(ch);
      cdv.setUint32(0, 0x02014b50, true);
      cdv.setUint16(4, 20, true);
      cdv.setUint16(6, 20, true);
      cdv.setUint16(8, 0x0800, true);
      cdv.setUint16(10, 0, true);
      cdv.setUint16(12, 0, true);
      cdv.setUint16(14, 0x21, true);
      cdv.setUint32(16, crc, true);
      cdv.setUint32(20, boyut, true);
      cdv.setUint32(24, boyut, true);
      cdv.setUint16(28, adBytes.length, true);
      cdv.setUint16(30, 0, true);
      cdv.setUint16(32, 0, true);
      cdv.setUint16(34, 0, true);
      cdv.setUint16(36, 0, true);
      cdv.setUint32(38, 0, true);
      cdv.setUint32(42, ofset, true);
      new Uint8Array(ch, 46).set(adBytes);

      yerelParcalar.push(new Uint8Array(lh), veriU8);
      merkeziParcalar.push(new Uint8Array(ch));
      ofset += lh.byteLength + boyut;
    }

    var merkeziBoyut = 0;
    for (var m = 0; m < merkeziParcalar.length; m++) {
      merkeziBoyut += merkeziParcalar[m].byteLength;
    }

    var eocd = new ArrayBuffer(22);
    var edv = new DataView(eocd);
    edv.setUint32(0, 0x06054b50, true);
    edv.setUint16(4, 0, true);
    edv.setUint16(6, 0, true);
    edv.setUint16(8, merkeziParcalar.length, true);
    edv.setUint16(10, merkeziParcalar.length, true);
    edv.setUint32(12, merkeziBoyut, true);
    edv.setUint32(16, ofset, true);
    edv.setUint16(20, 0, true);

    return new Blob(yerelParcalar.concat(merkeziParcalar, [new Uint8Array(eocd)]), {
      type: "application/zip"
    });
  }

  /* =========================================================
     SUNUCU / AĞ BİLGİSİ ALGILAMA
     ========================================================= */
  function varsayilanTabanAdres() {
    var yol = (window.location.pathname || "").replace(/\/index\.html$/i, "").replace(/\/(tahta|gonder|giris|kayit|g\/\d{6})\/?$/i, "").replace(/\/$/, "");
    return window.location.origin + yol;
  }

  var sunucuDurumu = {
    aktif: false,
    adres: varsayilanTabanAdres(),
    ip: window.location.hostname
  };

  var kullaniciDurumu = {
    kullanici: (function () {
      try {
        return JSON.parse(localStorage.getItem("tahta_aktif_kullanici") || "null");
      } catch (_) {
        return null;
      }
    })(),
    token: localStorage.getItem("tahta_oturum_token") || ""
  };

  function kullaniciArayuzGuncelle() {
    var misafirBar = $("ust-hesap-misafir");
    var kullaniciBar = $("ust-hesap-kullanici");
    var etiket = $("ust-kullanici-etiket");
    var telHesapBtn = $("btn-tel-hesap");
    var k = kullaniciDurumu.kullanici;

    if (k && k.ad) {
      if (misafirBar) misafirBar.hidden = true;
      if (kullaniciBar) kullaniciBar.hidden = false;
      if (etiket) etiket.textContent = k.ad + (k.kurum ? " · " + k.kurum : "");
      if (telHesapBtn) telHesapBtn.textContent = k.ad.split(" ")[0];
    } else {
      if (misafirBar) misafirBar.hidden = false;
      if (kullaniciBar) kullaniciBar.hidden = true;
      if (telHesapBtn) telHesapBtn.textContent = "Hesap / Giriş";
    }
  }

  async function sunucuBilgisiKontrolEt() {
    try {
      var basliklar = {};
      if (kullaniciDurumu.token) {
        basliklar["X-Oturum-Token"] = kullaniciDurumu.token;
      }
      var yanit = await fetch("/api/bilgi", { cache: "no-store", headers: basliklar });
      if (yanit.ok) {
        var veri = await yanit.json();
        sunucuDurumu.aktif = true;
        if (veri.adres && (location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
          sunucuDurumu.adres = veri.adres;
          sunucuDurumu.ip = veri.ip || location.hostname;
        } else {
          sunucuDurumu.adres = varsayilanTabanAdres();
        }
        if (veri.kullanici) {
          kullaniciDurumu.kullanici = veri.kullanici;
          kullaniciArayuzGuncelle();
        }
      }
    } catch (_) {
      sunucuDurumu.aktif = false;
    }
  }

  async function apiPost(yol, veri) {
    var basliklar = { "Content-Type": "application/json" };
    if (kullaniciDurumu.token) {
      basliklar["X-Oturum-Token"] = kullaniciDurumu.token;
    }
    var yanit = await fetch(yol, {
      method: "POST",
      headers: basliklar,
      body: JSON.stringify(veri || {})
    });
    var json = {};
    try {
      json = await yanit.json();
    } catch (_) {}
    if (!yanit.ok) {
      var hata = new Error(json.hata || ("HTTP " + yanit.status));
      hata.veri = json;
      hata.status = yanit.status;
      throw hata;
    }
    return json;
  }

  /* =========================================================
     UYGULAMA DURUMU VE GÖRÜNÜM YÖNLENDİRİCİ
     ========================================================= */
  var aktifGorunum = "giris"; // "giris" | "hesap" | "tahta" | "telefon"

  function gorunumGoster(hedef) {
    aktifGorunum = hedef;
    var gGiris = $("gorunum-giris");
    var gHesap = $("gorunum-hesap");
    var gTahta = $("gorunum-tahta");
    var gTel = $("gorunum-telefon");

    if (gGiris) gGiris.hidden = hedef !== "giris";
    if (gHesap) gHesap.hidden = hedef !== "hesap";
    if (gTahta) gTahta.hidden = hedef !== "tahta";
    if (gTel) gTel.hidden = hedef !== "telefon";
  }

  function hesapGorunumAc(sekme) {
    gorunumGoster("hesap");
    var btnGiris = $("sekme-btn-giris");
    var btnKayit = $("sekme-btn-kayit");
    var formGiris = $("form-hesap-giris");
    var formKayit = $("form-hesap-kayit");
    var kayitMi = sekme === "kayit";

    if (btnGiris) {
      btnGiris.classList.toggle("aktif", !kayitMi);
      btnGiris.setAttribute("aria-selected", kayitMi ? "false" : "true");
    }
    if (btnKayit) {
      btnKayit.classList.toggle("aktif", kayitMi);
      btnKayit.setAttribute("aria-selected", kayitMi ? "true" : "false");
    }
    if (formGiris) formGiris.hidden = kayitMi;
    if (formKayit) formKayit.hidden = !kayitMi;
  }

  /* =========================================================
     TAHTA EKRANI MANTIĞI (#gorunum-tahta)
     ========================================================= */
  var tahta = {
    basladi: false,
    kod: "",
    anahtar: "",
    sonMesajId: 0,
    ogrenciModu: false,
    peer: null,
    veriBaglantilari: {}, // peerId -> DataConnection
    broadcast: null,
    pollTimer: null,
    islenenMesajlar: new Set(),
    islenenDosyalar: new Set(),
    gelenParcalar: {}, // yerelId -> { meta, parcalar:[], alinan:0 }
    cihazlar: [],
    dosyalar: [],      // { id, yerel, ad, tur, boyut, blob, url, metin, baglantiUrl, kimden, onayli }
    onayBekleyenler: [],
    aktifIndeks: -1,
    // PDF & Sahne Durumu
    pdfBelge: null,
    pdfSayfa: 1,
    pdfToplam: 1,
    pdfSigdir: false,
    yakinlik: 1,
    aci: 0,
    kaydirX: 0,
    kaydirY: 0,
    // Çizim ve Lazer Durumu
    aktifArac: "imlec", // "imlec" | "kalem" | "fosforlu" | "lazer"
    cizimVerisi: [],    // [{ arac, renk, kalinlik, noktalar: [{x,y}] }]
    lazerNokta: null,   // { x, y, zaman }
    lazerTimer: null,
    beyazTahtaModu: false,
    canliAci: 0
  };

  async function tahtaBaslat() {
    gorunumGoster("tahta");
    if (tahta.basladi) return;
    tahta.basladi = true;

    await sunucuBilgisiKontrolEt();

    var kayitliKod = sessionStorage.getItem("tahta_oda_kod") || "";
    var kayitliAnahtar = sessionStorage.getItem("tahta_oda_anahtar") || "";

    if (sunucuDurumu.aktif) {
      try {
        var odaYanit = await apiPost("/api/oda_ac", {
          kod: kayitliKod,
          anahtar: kayitliAnahtar
        });
        tahta.kod = odaYanit.kod;
        tahta.anahtar = odaYanit.anahtar;
        tahta.qrJeton = odaYanit.qr_jeton || "";
        tahta.sonMesajId = odaYanit.son || 0;
        tahta.ogrenciModu = Boolean(odaYanit.ogrenci_modu);
      } catch (_) {
        tahta.kod = String(Math.floor(100000 + Math.random() * 900000));
        tahta.anahtar = rastgeleId("anahtar");
      }
    } else {
      tahta.kod = (/^\d{6}$/.test(kayitliKod))
        ? kayitliKod
        : String(Math.floor(100000 + Math.random() * 900000));
      tahta.anahtar = kayitliAnahtar || rastgeleId("anahtar");
    }

    sessionStorage.setItem("tahta_oda_kod", tahta.kod);
    sessionStorage.setItem("tahta_oda_anahtar", tahta.anahtar);

    tahtaKurulumUI();
    tahtaKanallariAc();
    tahtaCizimKatmaniKur();
  }

  function tahtaKurulumUI() {
    var kodParcali = kodBiçimle(tahta.kod).split(" ");
    var buyukKodEl = $("tahta-buyuk-kod");
    if (buyukKodEl) {
      buyukKodEl.textContent = (kodParcali[0] || "000") + " ";
      var kodSpan = document.createElement("span");
      kodSpan.textContent = kodParcali[1] || "000";
      buyukKodEl.appendChild(kodSpan);
    }
    var ustKodBtn = $("btn-ust-kod");
    if (ustKodBtn) {
      ustKodBtn.textContent = kodBiçimle(tahta.kod);
      ustKodBtn.hidden = false;
    }

    var baglantiUrl = sunucuDurumu.adres.replace(/\/$/, "") + "/?kod=" + tahta.kod + (tahta.qrJeton ? "&j=" + encodeURIComponent(tahta.qrJeton) : "");
    var adresMetin = $("tahta-adres-metin");
    if (adresMetin) {
      adresMetin.textContent = sunucuDurumu.adres.replace(/^https?:\/\//, "");
    }

    var qrKutu = $("tahta-qr-kutu");
    if (qrKutu) {
      qrKutu.innerHTML = "";
      if (typeof window.qrcode === "function") {
        var qr = window.qrcode(0, "M");
        qr.addData(baglantiUrl);
        qr.make();
        qrKutu.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 1, scalable: true });
      } else if (typeof window.QRCode === "function") {
        new window.QRCode(qrKutu, {
          text: baglantiUrl,
          width: 248,
          height: 248,
          colorDark: "#0F172A",
          colorLight: "#FFFFFF",
          correctLevel: window.QRCode.CorrectLevel ? window.QRCode.CorrectLevel.M : 0
        });
      } else {
        qrKutu.textContent = baglantiUrl;
      }
    }

    var chkOgrenci = $("chk-ogrenci-modu");
    if (chkOgrenci) {
      chkOgrenci.checked = tahta.ogrenciModu;
    }

    tahtaDurumGuncelle("Telefon bekleniyor · Kod: " + kodBiçimle(tahta.kod), false);
  }

  function tahtaDurumGuncelle(metin, bagliMi) {
    var rozet = $("tahta-durum-rozet");
    var yazi = $("tahta-durum-yazi");
    if (yazi) yazi.textContent = metin;
    if (rozet) {
      if (bagliMi) rozet.classList.add("bagli");
      else rozet.classList.remove("bagli");
    }
  }

  function tahtaKanallariAc() {
    // 1. BroadcastChannel (Aynı cihazdaki sekmeler arası anında iletişim)
    if (typeof window.BroadcastChannel === "function") {
      try {
        tahta.broadcast = new BroadcastChannel("tahta-at-" + tahta.kod);
        tahta.broadcast.onmessage = function (ev) {
          if (ev && ev.data) tahtaHamMesajIsle(ev.data, "broadcast");
        };
      } catch (_) {}
    }

    // 2. PeerJS (WebRTC Doğrudan P2P Veri ve Canlı Kamera/Ekran Akışı)
    if (typeof window.Peer === "function") {
      try {
        var peerId = "tahta-at-oda-" + tahta.kod;
        var p = new window.Peer(peerId, { debug: 0 });
        tahta.peer = p;

        p.on("connection", function (conn) {
          conn.on("open", function () {
            tahta.veriBaglantilari[conn.peer] = conn;
            tahtaP2pCihazEkle(conn.peer, conn.metadata && conn.metadata.ad);
            tahtaDurumSenkronGonder();
          });
          conn.on("data", function (veri) {
            tahtaHamMesajIsle(veri, "p2p", conn);
          });
          conn.on("close", function () {
            delete tahta.veriBaglantilari[conn.peer];
            tahtaCihazListesiYenileUI();
          });
        });

        p.on("call", function (call) {
          call.answer();
          call.on("stream", function (uzakAkis) {
            var baslik = (call.metadata && call.metadata.etiket) || "Canlı Kamera / Ekran";
            tahtaCanliYayinGoster(uzakAkis, baslik);
          });
          call.on("close", function () {
            tahtaCanliYayinKapat();
          });
        });
      } catch (_) {}
    }

    // 3. Yerel Sunucu HTTP Polling
    if (sunucuDurumu.aktif) {
      tahta.pollTimer = setInterval(tahtaSunucuYokla, 900);
      tahtaSunucuYokla();
    }
  }

  function tahtaP2pCihazEkle(id, ad) {
    var mevcut = tahta.cihazlar.find(function (c) { return c.id === id; });
    if (!mevcut) {
      tahta.cihazlar.push({
        id: id,
        ad: ad || "Telefon (P2P)",
        rol: "ogretmen",
        durum: "onayli",
        bagli: true
      });
    } else {
      mevcut.bagli = true;
    }
    tahtaCihazListesiYenileUI();
  }

  async function tahtaSunucuYokla() {
    if (!sunucuDurumu.aktif || !tahta.kod || document.hidden || aktifGorunum !== "tahta") return;
    try {
      var yanit = await apiPost("/api/tahta_durum", {
        kod: tahta.kod,
        anahtar: tahta.anahtar,
        son: tahta.sonMesajId
      });
      if (typeof yanit.son === "number" && yanit.son > tahta.sonMesajId) {
        tahta.sonMesajId = yanit.son;
      }
      if (Array.isArray(yanit.cihazlar)) {
        // P2P bağlı olanları koruyarak birleştir
        var sunucuCihazlar = yanit.cihazlar;
        var p2pOlanlar = tahta.cihazlar.filter(function (c) {
          return String(c.id).indexOf("tahta-") === 0 || tahta.veriBaglantilari[c.id];
        });
        tahta.cihazlar = sunucuCihazlar.concat(p2pOlanlar.filter(function (p) {
          return !sunucuCihazlar.some(function (s) { return s.id === p.id; });
        }));
        tahtaCihazListesiYenileUI();
      }
      if (Array.isArray(yanit.mesajlar)) {
        for (var i = 0; i < yanit.mesajlar.length; i++) {
          var m = yanit.mesajlar[i];
          tahtaHamMesajIsle({
            mesajId: "srv_" + m.id,
            kimden: m.kimden,
            tur: m.tur,
            veri: m.veri
          }, "http");
        }
      }
    } catch (_) {}
  }

  function tahtaMesajYayinla(tur, veri, hedefCihaz) {
    var paket = {
      mesajId: rastgeleId("m"),
      kimden: "tahta",
      kime: hedefCihaz || "hepsi",
      tur: tur,
      veri: veri || {}
    };

    // P2P DataConnections
    Object.keys(tahta.veriBaglantilari).forEach(function (pid) {
      var c = tahta.veriBaglantilari[pid];
      if (c && c.open) {
        try { c.send(paket); } catch (_) {}
      }
    });

    // BroadcastChannel
    if (tahta.broadcast) {
      try { tahta.broadcast.postMessage(paket); } catch (_) {}
    }

    // HTTP Server
    if (sunucuDurumu.aktif && tahta.kod) {
      apiPost("/api/mesaj", {
        kod: tahta.kod,
        kimden: "tahta",
        anahtar: tahta.anahtar,
        kime: hedefCihaz || "hepsi",
        tur: tur,
        veri: veri || {}
      }).catch(function () {});
    }
  }

  async function tahtaHamMesajIsle(paket, kaynak) {
    if (!paket || !paket.tur) return;
    if (paket.kimden === "tahta") return;

    var mid = paket.mesajId || (paket.veri && paket.veri.mesajId);
    if (mid) {
      if (tahta.islenenMesajlar.has(mid)) return;
      tahta.islenenMesajlar.add(mid);
    }

    var tur = paket.tur;
    var veri = paket.veri || {};

    if (tur === "merhaba") {
      tahtaP2pCihazEkle(paket.kimden || rastgeleId("tel"), veri.ad || "Telefon");
      var bekleKatman = $("tahta-bekle-katman");
      if (bekleKatman && !bekleKatman.hidden && tahta.dosyalar.length > 0) {
        bekleKatman.hidden = true;
      }
      var kapatBtn = $("btn-bekle-kapat");
      if (kapatBtn) kapatBtn.hidden = false;
      bildirimGoster((veri.ad || "Telefon") + " tahtaya bağlandı");
      tahtaDurumSenkronGonder();
      return;
    }

    if (tur === "dosya-basla") {
      tahta.gelenParcalar[veri.yerel] = {
        meta: veri,
        parcalar: [],
        alinan: 0
      };
      return;
    }

    if (tur === "dosya-parca") {
      var kayit = tahta.gelenParcalar[veri.yerel];
      if (!kayit) return;
      kayit.parcalar.push(veri.veri);
      if (veri.son) {
        var birlesikBlob = new Blob(kayit.parcalar, {
          type: kayit.meta.tur || "application/octet-stream"
        });
        delete tahta.gelenParcalar[veri.yerel];
        await tahtaYeniDosyaAlindi({
          id: veri.yerel,
          yerel: veri.yerel,
          ad: kayit.meta.ad,
          tur: dosyaTuruTahmin(kayit.meta.ad, kayit.meta.tur),
          boyut: birlesikBlob.size,
          blob: birlesikBlob,
          kimden: paket.kimden || "telefon"
        });
      }
      return;
    }

    if (tur === "dosya-hazir") {
      var tekilAnahtar = veri.yerel || veri.id;
      if (tekilAnahtar && tahta.islenenDosyalar.has(tekilAnahtar)) return;
      if (veri.id && sunucuDurumu.aktif) {
        try {
          var indirmeYanit = await fetch(
            "/api/dosya_indir?kod=" + encodeURIComponent(tahta.kod) +
            "&id=" + encodeURIComponent(veri.id) +
            "&anahtar=" + encodeURIComponent(tahta.anahtar)
          );
          if (indirmeYanit.ok) {
            var blob = await indirmeYanit.blob();
            await tahtaYeniDosyaAlindi({
              id: veri.id,
              yerel: veri.yerel || veri.id,
              ad: veri.ad,
              tur: dosyaTuruTahmin(veri.ad, veri.tur),
              boyut: blob.size,
              blob: blob,
              kimden: veri.kimden || paket.kimden || "telefon"
            });
          }
        } catch (_) {}
      }
      return;
    }

    if (tur === "baglanti-gonder") {
      var url = String(veri.url || "").trim();
      if (!url) return;
      await tahtaYeniDosyaAlindi({
        id: veri.yerel || rastgeleId("lnk"),
        yerel: veri.yerel || rastgeleId("lnk"),
        ad: veri.baslik || url,
        tur: "baglanti",
        boyut: url.length,
        baglantiUrl: url,
        kimden: paket.kimden || "telefon"
      });
      return;
    }

    if (tur === "kumanda") {
      tahtaKumandaUygula(veri);
      return;
    }

    if (tur === "cizim-darbe") {
      tahtaUzakCizimIsle(veri);
      return;
    }

    if (tur === "lazer-hareket") {
      tahtaLazerGoster(veri.x, veri.y);
      return;
    }

    if (tur === "cizim-temizle") {
      tahtaCizimTemizle(false);
      return;
    }

    if (tur === "beyaz-tahta-ac") {
      tahtaBeyazTahtaAc();
      return;
    }

    if (tur === "canli-kare") {
      tahtaCanliKareGoster(veri.veriUrl, veri.etiket);
      return;
    }

    if (tur === "canli-kapat") {
      tahtaCanliYayinKapat();
      return;
    }

    if (tur === "canli-kare-yakala") {
      tahtaCanliKareYakala();
      return;
    }

    if (tur === "sahne-telefona-iste") {
      tahtaAcikDosyayiTelefonaGonder();
      return;
    }
  }

  function tahtaCihazListesiYenileUI() {
    var kutu = $("tahta-cihaz-listesi");
    if (!kutu) return;

    var aktifBaglilar = tahta.cihazlar.filter(function (c) { return c.bagli !== false; });
    if (aktifBaglilar.length > 0) {
      tahtaDurumGuncelle(aktifBaglilar.length + " cihaz bağlı · Kod: " + kodBiçimle(tahta.kod), true);
      var kapatBtn = $("btn-bekle-kapat");
      if (kapatBtn) kapatBtn.hidden = false;
    } else {
      tahtaDurumGuncelle("Telefon bekleniyor · Kod: " + kodBiçimle(tahta.kod), false);
    }

    if (tahta.cihazlar.length === 0) {
      kutu.innerHTML = '<div style="font-size:13px;color:var(--board-muted)">Henüz bağlı telefon yok</div>';
      return;
    }

    kutu.innerHTML = "";
    tahta.cihazlar.forEach(function (c) {
      var satir = document.createElement("div");
      satir.className = "cihaz-satir";

      var bilgi = document.createElement("div");
      bilgi.textContent = c.ad + (c.rol === "ogrenci" ? " (Öğr.)" : "");
      satir.appendChild(bilgi);

      if (c.durum === "bekliyor") {
        var btnGrup = document.createElement("div");
        btnGrup.style.display = "flex";
        btnGrup.style.gap = "4px";

        var onaylaBtn = document.createElement("button");
        onaylaBtn.className = "dugme kucuk";
        onaylaBtn.style.padding = "4px 8px";
        onaylaBtn.style.fontSize = "11px";
        onaylaBtn.textContent = "Onayla";
        onaylaBtn.onclick = function () {
          tahtaCihazKararVer(c.id, "onay", "ogretmen");
        };

        var redBtn = document.createElement("button");
        redBtn.className = "dugme tehlike kucuk";
        redBtn.style.padding = "4px 8px";
        redBtn.style.fontSize = "11px";
        redBtn.textContent = "Red";
        redBtn.onclick = function () {
          tahtaCihazKararVer(c.id, "red", "ogretmen");
        };

        btnGrup.appendChild(onaylaBtn);
        btnGrup.appendChild(redBtn);
        satir.appendChild(btnGrup);
      } else {
        var etiket = document.createElement("span");
        etiket.className = "cihaz-etiket";
        etiket.textContent = c.bagli === false ? "Ayrıldı" : "Bağlı";
        satir.appendChild(etiket);
      }

      kutu.appendChild(satir);
    });
  }

  async function tahtaCihazKararVer(cihazId, karar, rol) {
    if (!sunucuDurumu.aktif) return;
    try {
      var yanit = await apiPost("/api/cihaz_karar", {
        kod: tahta.kod,
        anahtar: tahta.anahtar,
        cihaz: cihazId,
        karar: karar,
        rol: rol
      });
      if (Array.isArray(yanit.cihazlar)) {
        tahta.cihazlar = yanit.cihazlar;
        tahtaCihazListesiYenileUI();
      }
    } catch (_) {}
  }

  async function tahtaYeniDosyaAlindi(kayit) {
    var tekil = kayit.yerel || kayit.id;
    if (tekil) {
      if (tahta.islenenDosyalar.has(tekil)) return;
      tahta.islenenDosyalar.add(tekil);
    }

    if (kayit.blob && !kayit.url) {
      kayit.url = URL.createObjectURL(kayit.blob);
    }

    // Öğrenci gönderdiyse onay listesine al
    var gonderenCihaz = tahta.cihazlar.find(function (c) { return c.id === kayit.kimden; });
    var ogrenciMi = gonderenCihaz && gonderenCihaz.rol === "ogrenci";

    if (ogrenciMi) {
      kayit.gonderenAd = gonderenCihaz.ad || "Öğrenci";
      tahta.onayBekleyenler.push(kayit);
      tahtaOnayListesiYenileUI();
      bildirimGoster(kayit.gonderenAd + " bir dosya gönderdi (Onay bekliyor)");
      return;
    }

    tahtaDosyaKabulEt(kayit);
  }

  function tahtaDosyaKabulEt(kayit) {
    kayit.secili = true;
    tahta.dosyalar.push(kayit);
    var yeniIndeks = tahta.dosyalar.length - 1;

    // QR bekleme katmanını otomatik kapat
    var bekleKatman = $("tahta-bekle-katman");
    if (bekleKatman) bekleKatman.hidden = true;
    var kapatBtn = $("btn-bekle-kapat");
    if (kapatBtn) kapatBtn.hidden = false;

    tahtaDosyaListesiYenileUI();
    tahtaSahneGoster(yeniIndeks);

    // Otomatik kaydet açıksa indir
    var chkOto = $("chk-oto-kaydet");
    if (chkOto && chkOto.checked && kayit.blob) {
      blobIndir(kayit.blob, kayit.ad);
    }
  }

  function tahtaOnayListesiYenileUI() {
    var bolum = $("tahta-onay-bolum");
    var liste = $("tahta-onay-listesi");
    if (!bolum || !liste) return;

    if (tahta.onayBekleyenler.length === 0) {
      bolum.hidden = true;
      liste.innerHTML = "";
      return;
    }

    bolum.hidden = false;
    liste.innerHTML = "";
    tahta.onayBekleyenler.forEach(function (k, idx) {
      var li = document.createElement("li");
      li.className = "t-dosya-oge";
      li.innerHTML =
        '<span class="t-dosya-ikon">' + dosyaIkonEtiketi(k.tur, k.ad) + "</span>" +
        '<div class="t-dosya-bilgi">' +
          '<span class="t-dosya-ad"></span>' +
          '<span class="t-dosya-alt"></span>' +
        "</div>";
      li.querySelector(".t-dosya-ad").textContent = k.ad;
      li.querySelector(".t-dosya-alt").textContent = (k.gonderenAd || "Öğrenci") + " · " + boyutBiçimle(k.boyut);

      var onaylaBtn = document.createElement("button");
      onaylaBtn.className = "dugme kucuk";
      onaylaBtn.style.padding = "4px 8px";
      onaylaBtn.textContent = "Aç";
      onaylaBtn.onclick = function (e) {
        e.stopPropagation();
        tahta.onayBekleyenler.splice(idx, 1);
        tahtaOnayListesiYenileUI();
        tahtaDosyaKabulEt(k);
      };

      li.appendChild(onaylaBtn);
      liste.appendChild(li);
    });
  }

  function tahtaDosyaListesiYenileUI() {
    var baslik = $("tahta-gelenler-baslik");
    var liste = $("tahta-dosya-listesi");
    var indirBtn = $("btn-secilenleri-indir");
    if (baslik) baslik.textContent = "Gelen Dosyalar (" + tahta.dosyalar.length + ")";
    if (!liste) return;

    liste.innerHTML = "";
    var seciliSayisi = 0;

    tahta.dosyalar.forEach(function (d, idx) {
      if (d.secili) seciliSayisi++;
      var li = document.createElement("li");
      li.className = "t-dosya-oge" + (idx === tahta.aktifIndeks ? " aktif" : "");

      var chk = document.createElement("input");
      chk.type = "checkbox";
      chk.checked = Boolean(d.secili);
      chk.onclick = function (e) {
        e.stopPropagation();
        d.secili = chk.checked;
        tahtaDosyaListesiYenileUI();
      };

      var ikon = document.createElement("span");
      ikon.className = "t-dosya-ikon";
      ikon.textContent = dosyaIkonEtiketi(d.tur, d.ad);

      var bilgi = document.createElement("div");
      bilgi.className = "t-dosya-bilgi";
      var adEl = document.createElement("span");
      adEl.className = "t-dosya-ad";
      adEl.textContent = d.ad;
      var altEl = document.createElement("span");
      altEl.className = "t-dosya-alt";
      altEl.textContent = d.tur === "baglanti" ? "Web Bağlantısı" : boyutBiçimle(d.boyut);
      bilgi.appendChild(adEl);
      bilgi.appendChild(altEl);

      li.appendChild(chk);
      li.appendChild(ikon);
      li.appendChild(bilgi);

      li.onclick = function () {
        tahtaSahneGoster(idx);
      };

      liste.appendChild(li);
    });

    if (indirBtn) {
      indirBtn.disabled = seciliSayisi === 0;
      indirBtn.textContent = seciliSayisi > 1
        ? "Seçilenleri ZIP İndir (" + seciliSayisi + ")"
        : "Seçilenleri İndir";
    }

    tahtaDurumSenkronGonder();
  }

  /* =========================================================
     TAHTA SAHNE GÖSTERİMİ (PDF, GÖRSEL, VİDEO, BAĞLANTI)
     ========================================================= */
  async function tahtaSahneGoster(indeks) {
    if (indeks < 0 || indeks >= tahta.dosyalar.length) return;
    tahta.beyazTahtaModu = false;
    tahta.aktifIndeks = indeks;
    tahta.yakinlik = 1;
    tahta.aci = 0;
    tahta.kaydirX = 0;
    tahta.kaydirY = 0;
    tahta.pdfBelge = null;
    tahta.pdfSayfa = 1;
    tahta.pdfToplam = 1;
    tahtaCizimTemizle(false);

    var d = tahta.dosyalar[indeks];
    var icerik = $("tahta-icerik");
    if (!icerik) return;
    icerik.innerHTML = "";

    // Alt kontrol çubuğu görünürlüğü
    var altCubuk = $("tahta-alt-cubuk");
    var adEl = $("sahne-dosya-adi");
    var sayfaGrup = $("sahne-sayfa-grup");
    var yakinGrup = $("sahne-yakin-grup");
    var donGrup = $("sahne-don-grup");
    var siraEl = $("sahne-dosya-sira");
    var yeniSekmeBtn = $("btn-sahne-yeni-sekme");
    var indirBtn = $("btn-sahne-indir");

    if (altCubuk) altCubuk.hidden = false;
    if (adEl) adEl.textContent = d.ad;
    if (siraEl) siraEl.textContent = (indeks + 1) + " / " + tahta.dosyalar.length;

    var okSol = $("btn-sahne-onceki");
    var okSag = $("btn-sahne-sonraki");
    if (okSol) okSol.hidden = tahta.dosyalar.length <= 1;
    if (okSag) okSag.hidden = tahta.dosyalar.length <= 1;

    var tur = String(d.tur || "").toLowerCase();
    var pdfMi = tur.indexOf("pdf") !== -1 || String(d.ad || "").toLowerCase().endsWith(".pdf");
    var resimMi = tur.indexOf("image/") === 0;
    var videoMi = tur.indexOf("video/") === 0;
    var sesMi = tur.indexOf("audio/") === 0;
    var baglantiMi = tur === "baglanti";

    if (sayfaGrup) sayfaGrup.hidden = !pdfMi;
    if (yakinGrup) yakinGrup.hidden = !(pdfMi || resimMi);
    if (donGrup) donGrup.hidden = !(pdfMi || resimMi || videoMi);
    if (yeniSekmeBtn) {
      yeniSekmeBtn.hidden = !baglantiMi;
      yeniSekmeBtn.onclick = function () {
        if (d.baglantiUrl) window.open(d.baglantiUrl, "_blank", "noopener");
      };
    }
    if (indirBtn) {
      indirBtn.hidden = baglantiMi;
    }

    if (pdfMi && d.blob) {
      await tahtaPdfYukleVeCiz(d, icerik);
    } else if (resimMi && d.url) {
      var img = document.createElement("img");
      img.src = d.url;
      img.alt = d.ad;
      img.id = "sahne-aktif-medya";
      img.onload = function () {
        tahtaEkranGoruntusuTelefonaSenkronla();
      };
      icerik.appendChild(img);
    } else if (videoMi && d.url) {
      var video = document.createElement("video");
      video.src = d.url;
      video.controls = true;
      video.autoplay = true;
      video.playsInline = true;
      video.id = "sahne-aktif-medya";
      icerik.appendChild(video);
    } else if (sesMi && d.url) {
      var sesKutu = document.createElement("div");
      sesKutu.style.cssText = "background:#131B24;border:1px solid #233040;border-radius:16px;padding:32px;text-align:center;min-width:340px";
      var sesBaslik = document.createElement("div");
      sesBaslik.style.cssText = "font-weight:800;font-size:18px;margin-bottom:16px";
      sesBaslik.textContent = d.ad;
      var audio = document.createElement("audio");
      audio.src = d.url;
      audio.controls = true;
      audio.autoplay = true;
      audio.id = "sahne-aktif-medya";
      audio.style.width = "100%";
      sesKutu.appendChild(sesBaslik);
      sesKutu.appendChild(audio);
      icerik.appendChild(sesKutu);
    } else if (baglantiMi && d.baglantiUrl) {
      tahtaBaglantiSahneOlustur(d.baglantiUrl, icerik);
    } else if (d.blob && (tur.indexOf("text/") === 0 || /\.(txt|md|json|csv|py|js|html)$/i.test(d.ad))) {
      var metin = await d.blob.text();
      var pre = document.createElement("pre");
      pre.style.cssText = "max-width:90%;max-height:82%;overflow:auto;background:#131B24;color:#F8FAFC;padding:24px;border-radius:14px;border:1px solid #233040;font-family:var(--font-mono);font-size:15px;line-height:1.6;white-space:pre-wrap";
      pre.textContent = metin;
      icerik.appendChild(pre);
    } else {
      var kart = document.createElement("div");
      kart.style.cssText = "background:#131B24;border:1px solid #233040;border-radius:16px;padding:36px;text-align:center;max-width:440px";
      kart.innerHTML =
        '<div style="font-size:14px;font-weight:800;color:var(--accent);margin-bottom:8px">' + dosyaIkonEtiketi(d.tur, d.ad) + " DOSYASI</div>" +
        '<div style="font-size:20px;font-weight:800;margin-bottom:8px;word-break:break-word" id="kart-dosya-ad"></div>' +
        '<div style="font-size:14px;color:var(--board-muted);margin-bottom:20px">' + boyutBiçimle(d.boyut) + "</div>";
      kart.querySelector("#kart-dosya-ad").textContent = d.ad;
      var btn = document.createElement("button");
      btn.className = "dugme";
      btn.textContent = "Tahtaya İndir ve Aç";
      btn.onclick = function () {
        if (d.blob) blobIndir(d.blob, d.ad);
      };
      kart.appendChild(btn);
      icerik.appendChild(kart);
    }

    tahtaDosyaListesiYenileUI();
    tahtaDurumSenkronGonder();
  }

  async function tahtaPdfYukleVeCiz(dosya, kapsayici) {
    if (!window.pdfjsLib) {
      var iframe = document.createElement("iframe");
      iframe.src = dosya.url;
      iframe.style.cssText = "width:100%;height:100%;border:0;background:#FFF";
      kapsayici.appendChild(iframe);
      return;
    }

    try {
      var buf = await dosya.blob.arrayBuffer();
      var yukleme = window.pdfjsLib.getDocument({ data: buf });
      tahta.pdfBelge = await yukleme.promise;
      tahta.pdfToplam = tahta.pdfBelge.numPages || 1;
      tahta.pdfSayfa = 1;

      var tuval = document.createElement("canvas");
      tuval.id = "sahne-aktif-medya";
      tuval.style.cssText = "max-width:100%;max-height:100%;object-fit:contain;box-shadow:0 20px 50px rgba(0,0,0,0.45);background:#FFF;border-radius:4px";
      kapsayici.appendChild(tuval);

      await tahtaPdfSayfaCiz();
    } catch (_) {
      var yedekIframe = document.createElement("iframe");
      yedekIframe.src = dosya.url;
      yedekIframe.style.cssText = "width:100%;height:100%;border:0;background:#FFF";
      kapsayici.appendChild(yedekIframe);
    }
  }

  async function tahtaPdfSayfaCiz() {
    if (!tahta.pdfBelge) return;
    var tuval = $("sahne-aktif-medya");
    var sahne = $("tahta-sahne");
    if (!tuval || !sahne) return;

    var sayfaNo = Math.max(1, Math.min(tahta.pdfToplam, tahta.pdfSayfa));
    tahta.pdfSayfa = sayfaNo;

    var sayfaYazi = $("sahne-sayfa-yazi");
    if (sayfaYazi) {
      sayfaYazi.textContent = "Sayfa " + sayfaNo + " / " + tahta.pdfToplam;
    }

    var sayfa = await tahta.pdfBelge.getPage(sayfaNo);
    var hamViewport = sayfa.getViewport({ scale: 1, rotation: (tahta.aci % 360 + 360) % 360 });
    var sahneGen = Math.max(320, sahne.clientWidth - 48);
    var sahneYuk = Math.max(240, sahne.clientHeight - 90);

    var bazOlcek = tahta.pdfSigdir
      ? (sahneGen / hamViewport.width)
      : Math.min(sahneGen / hamViewport.width, sahneYuk / hamViewport.height);

    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var sonOlcek = Math.max(0.4, Math.min(4.0, bazOlcek * tahta.yakinlik));
    var viewport = sayfa.getViewport({
      scale: sonOlcek * dpr,
      rotation: (tahta.aci % 360 + 360) % 360
    });

    tuval.width = Math.floor(viewport.width);
    tuval.height = Math.floor(viewport.height);
    tuval.style.width = Math.floor(viewport.width / dpr) + "px";
    tuval.style.height = Math.floor(viewport.height / dpr) + "px";

    if (tahta.pdfSigdir || tahta.yakinlik > 1) {
      tuval.style.maxWidth = "none";
      tuval.style.maxHeight = "none";
    } else {
      tuval.style.maxWidth = "100%";
      tuval.style.maxHeight = "100%";
    }

    var ctx = tuval.getContext("2d");
    await sayfa.render({ canvasContext: ctx, viewport: viewport }).promise;

    tahtaDurumSenkronGonder();
    tahtaEkranGoruntusuTelefonaSenkronla();
  }

  function tahtaBaglantiSahneOlustur(url, kapsayici) {
    try {
      var u = new URL(url);
      if (u.protocol !== "https:" && u.protocol !== "http:") return;
    } catch (_) {
      return;
    }

    var gomuluUrl = null;

    // YouTube algılama
    var ytEslesme = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{6,15})/i);
    if (ytEslesme && ytEslesme[1]) {
      gomuluUrl = "https://www.youtube.com/embed/" + ytEslesme[1] + "?autoplay=1&rel=0";
    }

    // Instagram algılama
    if (!gomuluUrl) {
      var igEslesme = url.match(/instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/i);
      if (igEslesme && igEslesme[1]) {
        gomuluUrl = "https://www.instagram.com/p/" + igEslesme[1] + "/embed";
      }
    }

    if (gomuluUrl) {
      var iframe = document.createElement("iframe");
      iframe.src = gomuluUrl;
      iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-presentation");
      iframe.referrerPolicy = "no-referrer";
      iframe.allow = "autoplay; fullscreen; picture-in-picture";
      iframe.allowFullscreen = true;
      iframe.style.cssText = "width:92%;height:86%;border:0;border-radius:14px;background:#000";
      kapsayici.appendChild(iframe);
      return;
    }

    // Genel web bağlantısı
    var sarmal = document.createElement("div");
    sarmal.style.cssText = "width:92%;height:86%;display:flex;flex-direction:column;gap:10px";
    var ustBilgi = document.createElement("div");
    ustBilgi.style.cssText = "display:flex;align-items:center;justify-content:space-between;background:#131B24;padding:10px 16px;border-radius:10px;border:1px solid #233040";
    var span = document.createElement("span");
    span.style.cssText = "font-family:var(--font-mono);font-size:13px;color:#94A3B8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    span.textContent = url;
    var acBtn = document.createElement("a");
    acBtn.href = url;
    acBtn.target = "_blank";
    acBtn.rel = "noopener noreferrer";
    acBtn.className = "dugme kucuk";
    acBtn.textContent = "Yeni Sekmede Aç ↗";
    ustBilgi.appendChild(span);
    ustBilgi.appendChild(acBtn);

    var webFrame = document.createElement("iframe");
    webFrame.src = url;
    webFrame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-presentation");
    webFrame.referrerPolicy = "no-referrer";
    webFrame.style.cssText = "flex:1;width:100%;border:0;border-radius:12px;background:#FFF";

    sarmal.appendChild(ustBilgi);
    sarmal.appendChild(webFrame);
    kapsayici.appendChild(sarmal);
  }

  function tahtaMedyaDonusumUygula() {
    if (tahta.pdfBelge) {
      tahtaPdfSayfaCiz();
      return;
    }
    var medya = $("sahne-aktif-medya");
    if (!medya) return;
    medya.style.transform =
      "translate(" + tahta.kaydirX + "px, " + tahta.kaydirY + "px) " +
      "scale(" + tahta.yakinlik + ") " +
      "rotate(" + tahta.aci + "deg)";
    var yuzdeBtn = $("btn-yakin-sifir");
    if (yuzdeBtn) yuzdeBtn.textContent = "%" + Math.round(tahta.yakinlik * 100);
  }

  function tahtaBeyazTahtaAc() {
    tahta.beyazTahtaModu = true;
    tahta.pdfBelge = null;
    tahtaCizimTemizle(false);

    var bekleKatman = $("tahta-bekle-katman");
    if (bekleKatman) bekleKatman.hidden = true;

    var icerik = $("tahta-icerik");
    if (icerik) {
      icerik.innerHTML =
        '<div id="sahne-beyaz-tahta" style="width:94%;height:90%;background:#FFFFFF;border-radius:12px;box-shadow:0 20px 50px rgba(0,0,0,0.4);position:relative;display:flex;align-items:flex-end;justify-content:flex-end;padding:12px">' +
          '<span style="font-size:12px;font-weight:700;color:#94A3B8;user-select:none">CANLI BEYAZ TAHTA</span>' +
        "</div>";
    }
    var altCubuk = $("tahta-alt-cubuk");
    if (altCubuk) altCubuk.hidden = true;

    tahtaDurumSenkronGonder();
    tahtaEkranGoruntusuTelefonaSenkronla();
  }

  /* =========================================================
     TAHTA <-> TELEFON CANLI EKRAN & DURUM SENKRONU
     ========================================================= */
  function tahtaDurumSenkronGonder() {
    var aktif = tahta.dosyalar[tahta.aktifIndeks] || null;
    var listeOzet = tahta.dosyalar.map(function (d, i) {
      return {
        indeks: i,
        ad: d.ad,
        tur: d.tur,
        boyut: d.boyut,
        aktif: i === tahta.aktifIndeks
      };
    });

    tahtaMesajYayinla("tahta-durum-senkron", {
      beyazTahta: tahta.beyazTahtaModu,
      aktifIndeks: tahta.aktifIndeks,
      aktifAd: tahta.beyazTahtaModu ? "Beyaz Tahta" : (aktif ? aktif.ad : ""),
      aktifTur: tahta.beyazTahtaModu ? "beyaz-tahta" : (aktif ? aktif.tur : ""),
      pdfSayfa: tahta.pdfSayfa,
      pdfToplam: tahta.pdfToplam,
      yakinlik: tahta.yakinlik,
      dosyalar: listeOzet
    });
  }

  function tahtaEkranGoruntusuTelefonaSenkronla() {
    try {
      var kucukTuval = document.createElement("canvas");
      var kCtx = kucukTuval.getContext("2d");

      if (tahta.beyazTahtaModu) {
        kucukTuval.width = 640;
        kucukTuval.height = 360;
        kCtx.fillStyle = "#FFFFFF";
        kCtx.fillRect(0, 0, 640, 360);
      } else {
        var medya = $("sahne-aktif-medya");
        if (!medya) return;
        var kaynakGen = medya.width || medya.naturalWidth || 640;
        var kaynakYuk = medya.height || medya.naturalHeight || 360;
        var oran = Math.min(720 / kaynakGen, 720 / kaynakYuk, 1);
        kucukTuval.width = Math.max(160, Math.round(kaynakGen * oran));
        kucukTuval.height = Math.max(120, Math.round(kaynakYuk * oran));
        kCtx.drawImage(medya, 0, 0, kucukTuval.width, kucukTuval.height);
      }

      var veriUrl = kucukTuval.toDataURL("image/jpeg", 0.72);
      tahtaMesajYayinla("sahne-onizleme", {
        veriUrl: veriUrl,
        gen: kucukTuval.width,
        yuk: kucukTuval.height
      });
    } catch (_) {}
  }

  /* =========================================================
     TAHTA ÜZERİNDE CANLI ÇİZİM VE LAZER KATMANI
     ========================================================= */
  function tahtaCizimKatmaniKur() {
    var tuval = $("tahta-cizim-katman");
    var sahne = $("tahta-sahne");
    if (!tuval || !sahne) return;

    function boyutlandir() {
      var r = sahne.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      tuval.width = Math.floor(r.width);
      tuval.height = Math.floor(r.height);
      tahtaCizimYenidenCiz();
    }

    window.addEventListener("resize", boyutlandir);
    setTimeout(boyutlandir, 150);

    var ciziyor = false;
    var aktifDarbe = null;

    function normKoord(ev) {
      var r = tuval.getBoundingClientRect();
      return {
        x: Math.max(0, Math.min(1, (ev.clientX - r.left) / (r.width || 1))),
        y: Math.max(0, Math.min(1, (ev.clientY - r.top) / (r.height || 1)))
      };
    }

    tuval.addEventListener("pointerdown", function (ev) {
      if (tahta.aktifArac === "imlec") return;
      tuval.setPointerCapture(ev.pointerId);
      var n = normKoord(ev);

      if (tahta.aktifArac === "lazer") {
        ciziyor = true;
        tahtaLazerGoster(n.x, n.y);
        return;
      }

      ciziyor = true;
      aktifDarbe = {
        arac: tahta.aktifArac,
        renk: tahta.aktifArac === "fosforlu" ? "rgba(250, 204, 21, 0.42)" : "#EF4444",
        kalinlik: tahta.aktifArac === "fosforlu" ? 22 : 4.5,
        noktalar: [n]
      };
      tahta.cizimVerisi.push(aktifDarbe);
      tahtaCizimYenidenCiz();
    });

    tuval.addEventListener("pointermove", function (ev) {
      if (!ciziyor) return;
      var n = normKoord(ev);
      if (tahta.aktifArac === "lazer") {
        tahtaLazerGoster(n.x, n.y);
        return;
      }
      if (aktifDarbe) {
        aktifDarbe.noktalar.push(n);
        tahtaCizimYenidenCiz();
      }
    });

    function bitir() {
      ciziyor = false;
      aktifDarbe = null;
    }
    tuval.addEventListener("pointerup", bitir);
    tuval.addEventListener("pointercancel", bitir);
  }

  function tahtaUzakCizimIsle(veri) {
    if (!veri || !Array.isArray(veri.noktalar) || veri.noktalar.length === 0) return;
    tahta.cizimVerisi.push({
      arac: veri.arac || "kalem",
      renk: veri.renk || "#EF4444",
      kalinlik: veri.kalinlik || 4.5,
      noktalar: veri.noktalar
    });
    tahtaCizimYenidenCiz();
  }

  function tahtaLazerGoster(nx, ny) {
    if (typeof nx !== "number" || typeof ny !== "number") return;
    tahta.lazerNokta = { x: nx, y: ny, zaman: Date.now() };
    tahtaCizimYenidenCiz();
    if (tahta.lazerTimer) clearTimeout(tahta.lazerTimer);
    tahta.lazerTimer = setTimeout(function () {
      tahta.lazerNokta = null;
      tahtaCizimYenidenCiz();
    }, 900);
  }

  function tahtaCizimTemizle(yayinla) {
    tahta.cizimVerisi = [];
    tahta.lazerNokta = null;
    tahtaCizimYenidenCiz();
    if (yayinla !== false) {
      tahtaMesajYayinla("cizim-temizle", {});
    }
  }

  function tahtaCizimYenidenCiz() {
    var tuval = $("tahta-cizim-katman");
    if (!tuval) return;
    var sahne = $("tahta-sahne");
    if (sahne && (tuval.width !== sahne.clientWidth || tuval.height !== sahne.clientHeight)) {
      tuval.width = Math.max(1, sahne.clientWidth);
      tuval.height = Math.max(1, sahne.clientHeight);
    }

    var ctx = tuval.getContext("2d");
    var w = tuval.width;
    var h = tuval.height;
    ctx.clearRect(0, 0, w, h);

    for (var i = 0; i < tahta.cizimVerisi.length; i++) {
      var d = tahta.cizimVerisi[i];
      var pts = d.noktalar;
      if (!pts || pts.length === 0) continue;

      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = d.renk || "#EF4444";
      ctx.lineWidth = d.kalinlik || 4.5;

      ctx.beginPath();
      ctx.moveTo(pts[0].x * w, pts[0].y * h);
      for (var j = 1; j < pts.length; j++) {
        ctx.lineTo(pts[j].x * w, pts[j].y * h);
      }
      if (pts.length === 1) {
        ctx.lineTo(pts[0].x * w + 0.5, pts[0].y * h + 0.5);
      }
      ctx.stroke();
      ctx.restore();
    }

    if (tahta.lazerNokta) {
      var lx = tahta.lazerNokta.x * w;
      var ly = tahta.lazerNokta.y * h;
      ctx.save();
      ctx.beginPath();
      ctx.arc(lx, ly, 18, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(239, 68, 68, 0.28)";
      ctx.fill();

      ctx.beginPath();
      ctx.arc(lx, ly, 7.5, 0, Math.PI * 2);
      ctx.fillStyle = "#EF4444";
      ctx.fill();

      ctx.beginPath();
      ctx.arc(lx, ly, 3, 0, Math.PI * 2);
      ctx.fillStyle = "#FFFFFF";
      ctx.fill();
      ctx.restore();
    }
  }

  /* =========================================================
     TAHTA CANLI KAMERA / EKRAN KATMANI
     ========================================================= */
  function tahtaCanliYayinGoster(mediaStream, etiket) {
    var katman = $("tahta-canli-katman");
    var video = $("tahta-canli-video");
    var resim = $("tahta-canli-resim");
    var etiketEl = $("tahta-canli-etiket");
    var bekle = $("tahta-bekle-katman");

    if (bekle) bekle.hidden = true;
    if (katman) katman.hidden = false;
    if (etiketEl) etiketEl.textContent = etiket || "Telefon Kamerası";
    if (resim) resim.hidden = true;
    if (video) {
      video.hidden = false;
      video.srcObject = mediaStream;
      video.play().catch(function () {});
    }
  }

  function tahtaCanliKareGoster(veriUrl, etiket) {
    if (!veriUrl) return;
    var katman = $("tahta-canli-katman");
    var video = $("tahta-canli-video");
    var resim = $("tahta-canli-resim");
    var etiketEl = $("tahta-canli-etiket");
    var bekle = $("tahta-bekle-katman");

    if (bekle) bekle.hidden = true;
    if (katman) katman.hidden = false;
    if (etiketEl && etiket) etiketEl.textContent = etiket;
    if (video && !video.srcObject) video.hidden = true;
    if (resim) {
      resim.hidden = false;
      resim.src = veriUrl;
    }
  }

  function tahtaCanliYayinKapat() {
    var katman = $("tahta-canli-katman");
    var video = $("tahta-canli-video");
    var resim = $("tahta-canli-resim");
    if (video) {
      video.srcObject = null;
    }
    if (resim) {
      resim.src = "";
      resim.hidden = true;
    }
    if (katman) katman.hidden = true;
  }

  function tahtaCanliKareYakala() {
    var video = $("tahta-canli-video");
    var resim = $("tahta-canli-resim");
    var kaynak = (video && !video.hidden && video.videoWidth > 0) ? video : (resim && !resim.hidden ? resim : null);
    if (!kaynak) return;

    var w = kaynak.videoWidth || kaynak.naturalWidth || 1280;
    var h = kaynak.videoHeight || kaynak.naturalHeight || 720;
    var tuval = document.createElement("canvas");
    tuval.width = w;
    tuval.height = h;
    var ctx = tuval.getContext("2d");
    ctx.drawImage(kaynak, 0, 0, w, h);

    tuval.toBlob(function (blob) {
      if (!blob) return;
      var ad = "kamera-kare-" + new Date().toLocaleTimeString("tr-TR").replace(/:/g, "-") + ".png";
      tahtaCanliYayinKapat();
      tahtaDosyaKabulEt({
        id: rastgeleId("kare"),
        yerel: rastgeleId("kare"),
        ad: ad,
        tur: "image/png",
        boyut: blob.size,
        blob: blob,
        url: URL.createObjectURL(blob),
        kimden: "kamera"
      });
      bildirimGoster("Canlı görüntü fotoğraf olarak sahneye alındı");
    }, "image/png");
  }

  /* =========================================================
     TAHTA KUMANDA KOMUTLARI İŞLEYİCİSİ
     ========================================================= */
  function tahtaKumandaUygula(veri) {
    if (!veri || !veri.eylem) return;
    var eylem = veri.eylem;

    if (eylem === "ileri") {
      if (tahta.pdfBelge && tahta.pdfSayfa < tahta.pdfToplam) {
        tahta.pdfSayfa++;
        tahtaPdfSayfaCiz();
      } else if (tahta.aktifIndeks < tahta.dosyalar.length - 1) {
        tahtaSahneGoster(tahta.aktifIndeks + 1);
      }
      return;
    }

    if (eylem === "geri") {
      if (tahta.pdfBelge && tahta.pdfSayfa > 1) {
        tahta.pdfSayfa--;
        tahtaPdfSayfaCiz();
      } else if (tahta.aktifIndeks > 0) {
        tahtaSahneGoster(tahta.aktifIndeks - 1);
      }
      return;
    }

    if (eylem === "dosya-sec" && typeof veri.indeks === "number") {
      tahtaSahneGoster(veri.indeks);
      return;
    }

    if (eylem === "yakinlas") {
      tahta.yakinlik = Math.min(4, +(tahta.yakinlik + 0.25).toFixed(2));
      tahtaMedyaDonusumUygula();
      return;
    }

    if (eylem === "uzaklas") {
      tahta.yakinlik = Math.max(0.4, +(tahta.yakinlik - 0.25).toFixed(2));
      tahtaMedyaDonusumUygula();
      return;
    }

    if (eylem === "sifirla") {
      tahta.yakinlik = 1;
      tahta.kaydirX = 0;
      tahta.kaydirY = 0;
      tahta.pdfSigdir = !tahta.pdfSigdir;
      tahtaMedyaDonusumUygula();
      return;
    }

    if (eylem === "don-sol") {
      tahta.aci = (tahta.aci - 90) % 360;
      tahtaMedyaDonusumUygula();
      return;
    }

    if (eylem === "don-sag") {
      tahta.aci = (tahta.aci + 90) % 360;
      tahtaMedyaDonusumUygula();
      return;
    }

    if (eylem === "kaydir") {
      tahta.kaydirX += (Number(veri.dx) || 0);
      tahta.kaydirY += (Number(veri.dy) || 0);
      tahtaMedyaDonusumUygula();
      return;
    }

    if (eylem === "oynat-durdur") {
      var medya = $("sahne-aktif-medya");
      if (medya && typeof medya.paused === "boolean") {
        if (medya.paused) medya.play().catch(function () {});
        else medya.pause();
      }
      return;
    }

    if (eylem === "sunum-modu") {
      tahtaSunumModuDegistir();
      return;
    }

    if (eylem === "qr-ac-kapat") {
      var bekle = $("tahta-bekle-katman");
      if (bekle) bekle.hidden = !bekle.hidden;
      return;
    }
  }

  function tahtaSunumModuDegistir() {
    var kapsayici = $("gorunum-tahta");
    var cikBtn = $("btn-sunumdan-cik");
    if (!kapsayici) return;
    var aktifMi = kapsayici.classList.toggle("sunum-modu");
    if (cikBtn) cikBtn.hidden = !aktifMi;
    if (aktifMi && document.documentElement.requestFullscreen && !document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(function () {});
    }
    setTimeout(tahtaCizimYenidenCiz, 120);
  }

  /* =========================================================
     TAHTADAN TELEFONA DOSYA VE EKRAN GÖRÜNTÜSÜ GÖNDERİMİ
     ========================================================= */
  async function tahtaDosyayiTelefonaGonder(blob, ad, tur) {
    if (!blob) return;
    var yerel = rastgeleId("t2p");
    var boyut = blob.size;

    // 1. P2P & BroadcastChannel üzerinden gönder
    var metaPaket = {
      mesajId: rastgeleId("m"),
      kimden: "tahta",
      tur: "tahtadan-dosya-basla",
      veri: { yerel: yerel, ad: ad, tur: tur, boyut: boyut }
    };

    Object.keys(tahta.veriBaglantilari).forEach(function (pid) {
      var c = tahta.veriBaglantilari[pid];
      if (c && c.open) {
        try { c.send(metaPaket); } catch (_) {}
      }
    });
    if (tahta.broadcast) {
      try { tahta.broadcast.postMessage(metaPaket); } catch (_) {}
    }

    var buf = await blob.arrayBuffer();
    var parcaBoyut = 32 * 1024;
    for (var ofset = 0; ofset < buf.byteLength; ofset += parcaBoyut) {
      var sonMu = (ofset + parcaBoyut) >= buf.byteLength;
      var dilim = buf.slice(ofset, ofset + parcaBoyut);
      var parcaPaket = {
        mesajId: rastgeleId("m"),
        kimden: "tahta",
        tur: "tahtadan-dosya-parca",
        veri: { yerel: yerel, veri: dilim, son: sonMu }
      };
      Object.keys(tahta.veriBaglantilari).forEach(function (pid) {
        var c = tahta.veriBaglantilari[pid];
        if (c && c.open) {
          try { c.send(parcaPaket); } catch (_) {}
        }
      });
      if (tahta.broadcast) {
        try { tahta.broadcast.postMessage(parcaPaket); } catch (_) {}
      }
    }

    // 2. Sunucu aktifse HTTP üzerinden de yükle
    if (sunucuDurumu.aktif && tahta.kod) {
      try {
        var sorgu =
          "?kod=" + encodeURIComponent(tahta.kod) +
          "&id=" + encodeURIComponent(yerel) +
          "&yerel=" + encodeURIComponent(yerel) +
          "&ad=" + encodeURIComponent(ad) +
          "&tur=" + encodeURIComponent(tur) +
          "&boyut=" + encodeURIComponent(boyut) +
          "&kimden=tahta&anahtar=" + encodeURIComponent(tahta.anahtar) +
          "&hedef=hepsi&son=1";
        await fetch("/api/dosya_yukle" + sorgu, {
          method: "POST",
          body: blob
        });
      } catch (_) {}
    }

    bildirimGoster('"' + ad + '" bağlı telefonlara gönderildi');
  }

  function tahtaAcikDosyayiTelefonaGonder() {
    var aktif = tahta.dosyalar[tahta.aktifIndeks];
    if (!aktif || !aktif.blob) {
      bildirimGoster("Gönderilecek açık bir dosya yok");
      return;
    }
    tahtaDosyayiTelefonaGonder(aktif.blob, aktif.ad, aktif.tur);
  }

  function tahtaSahneGoruntusuGonder() {
    var sahne = $("tahta-sahne");
    var cizimTuval = $("tahta-cizim-katman");
    if (!sahne) return;

    var w = sahne.clientWidth || 1280;
    var h = sahne.clientHeight || 720;
    var birlesik = document.createElement("canvas");
    birlesik.width = w;
    birlesik.height = h;
    var ctx = birlesik.getContext("2d");

    ctx.fillStyle = tahta.beyazTahtaModu ? "#FFFFFF" : "#0B0F14";
    ctx.fillRect(0, 0, w, h);

    var medya = $("sahne-aktif-medya");
    if (medya && (medya.tagName === "IMG" || medya.tagName === "CANVAS" || medya.tagName === "VIDEO")) {
      try {
        var rSahne = sahne.getBoundingClientRect();
        var rMedya = medya.getBoundingClientRect();
        ctx.drawImage(
          medya,
          rMedya.left - rSahne.left,
          rMedya.top - rSahne.top,
          rMedya.width,
          rMedya.height
        );
      } catch (_) {}
    }

    if (cizimTuval) {
      try {
        ctx.drawImage(cizimTuval, 0, 0, w, h);
      } catch (_) {}
    }

    birlesik.toBlob(function (blob) {
      if (!blob) return;
      var ad = "tahta-goruntusu-" + new Date().toLocaleTimeString("tr-TR").replace(/:/g, "-") + ".png";
      tahtaDosyayiTelefonaGonder(blob, ad, "image/png");
    }, "image/png");
  }

  /* =========================================================
     TELEFON / KUMANDA MANTIĞI (#gorunum-telefon)
     ========================================================= */
  var telefon = {
    kod: "",
    cihazId: "",
    cihazAnahtar: "",
    rol: "ogretmen",
    durum: "onayli",
    sonMesajId: 0,
    peer: null,
    conn: null,
    medyaArama: null,
    broadcast: null,
    pollTimer: null,
    islenenMesajlar: new Set(),
    islenenDosyalar: new Set(),
    gelenParcalar: {},
    tahtadanGelenler: [],
    okunmamisSayisi: 0,
    // Canlı Ekran Senkron & Çizim
    aktifArac: "lazer", // "lazer" | "kalem-kirmizi" | "kalem-mavi" | "fosforlu"
    arkaplanResim: null,
    // Canlı Kamera / Ekran Paylaşımı
    canliAkis: null,
    kameraYon: "environment",
    kareTimer: null,
    tahtaAcikDosya: null
  };

  async function telefonGorunumAc(baslangicKodu) {
    gorunumGoster("telefon");
    await sunucuBilgisiKontrolEt();

    var kod = String(baslangicKodu || "").replace(/\D/g, "").slice(0, 6);
    if (kod.length === 6) {
      telefonOdayaBaglan(kod, "");
    } else {
      telefonAltEkranGoster("kod");
    }
  }

  function telefonAltEkranGoster(ad) {
    var eKod = $("tel-ekran-kod");
    var eAd = $("tel-ekran-ad");
    var eBagli = $("tel-ekran-bagli");
    var baskaBtn = $("btn-baska-tahta");

    if (eKod) eKod.hidden = ad !== "kod";
    if (eAd) eAd.hidden = ad !== "ad";
    if (eBagli) eBagli.hidden = ad !== "bagli";
    if (baskaBtn) baskaBtn.hidden = ad !== "bagli";
  }

  async function telefonOdayaBaglan(kod, ogrenciAd) {
    var temizKod = String(kod || "").replace(/\D/g, "").slice(0, 6);
    var hataEl = $("tel-kod-hata");
    if (hataEl) hataEl.textContent = "";

    if (temizKod.length !== 6) {
      if (hataEl) hataEl.textContent = "Lütfen tahtadaki 6 haneli kodu eksiksiz yaz.";
      return;
    }

    telefon.kod = temizKod;

    // Yerel sunucu varsa önce /api/katil ile doğrula
    if (sunucuDurumu.aktif) {
      try {
        var kayitliCid = sessionStorage.getItem("tel_cid_" + temizKod) || "";
        var kayitliAnahtar = sessionStorage.getItem("tel_anahtar_" + temizKod) || "";
        var urlJeton = new URLSearchParams(window.location.search).get("j") || "";
        var yanit = await apiPost("/api/katil", {
          kod: temizKod,
          qr_jeton: urlJeton,
          cihaz: kayitliCid,
          canahtar: kayitliAnahtar,
          ad: (kullaniciDurumu.kullanici && kullaniciDurumu.kullanici.ad) || cihazAdiBul(),
          ogrenci_ad: ogrenciAd || ""
        });
        telefon.cihazId = yanit.cihaz;
        telefon.cihazAnahtar = yanit.canahtar;
        telefon.rol = yanit.rol || "ogretmen";
        telefon.durum = yanit.durum || "onayli";
        telefon.sonMesajId = yanit.son || 0;
        sessionStorage.setItem("tel_cid_" + temizKod, telefon.cihazId);
        sessionStorage.setItem("tel_anahtar_" + temizKod, telefon.cihazAnahtar);
      } catch (err) {
        if (err && err.veri && err.veri.ad_gerekli) {
          telefonAltEkranGoster("ad");
          return;
        }
        if (hataEl) hataEl.textContent = err.message || "Tahtaya bağlanılamadı.";
        telefonAltEkranGoster("kod");
        return;
      }
    } else {
      telefon.cihazId = rastgeleId("tel");
    }

    telefonAltEkranGoster("bagli");
    telefonKanallariAc();
    telefonSenkronTuvalKur();
    telefonDokunmatikPedKur();
  }

  function telefonKanallariAc() {
    var durumMetin = $("tel-baglanti-metin");
    var kanalEtiket = $("tel-baglanti-kanal");
    if (durumMetin) {
      durumMetin.textContent = telefon.durum === "bekliyor"
        ? "Tahtadan onay bekleniyor…"
        : "Tahtaya bağlısın · Kod: " + kodBiçimle(telefon.kod);
    }

    // 1. BroadcastChannel
    if (typeof window.BroadcastChannel === "function") {
      try {
        if (telefon.broadcast) telefon.broadcast.close();
        telefon.broadcast = new BroadcastChannel("tahta-at-" + telefon.kod);
        telefon.broadcast.onmessage = function (ev) {
          if (ev && ev.data) telefonHamMesajIsle(ev.data);
        };
        telefon.broadcast.postMessage({
          mesajId: rastgeleId("m"),
          kimden: telefon.cihazId,
          tur: "merhaba",
          veri: { ad: cihazAdiBul() }
        });
      } catch (_) {}
    }

    // 2. PeerJS WebRTC P2P
    if (typeof window.Peer === "function") {
      try {
        if (telefon.peer) telefon.peer.destroy();
        var p = new window.Peer({ debug: 0 });
        telefon.peer = p;

        p.on("open", function () {
          var hedefId = "tahta-at-oda-" + telefon.kod;
          var conn = p.connect(hedefId, {
            reliable: true,
            metadata: { ad: cihazAdiBul() }
          });
          conn.on("open", function () {
            telefon.conn = conn;
            if (kanalEtiket) kanalEtiket.textContent = "Doğrudan P2P";
            conn.send({
              mesajId: rastgeleId("m"),
              kimden: telefon.cihazId,
              tur: "merhaba",
              veri: { ad: cihazAdiBul() }
            });
          });
          conn.on("data", function (veri) {
            telefonHamMesajIsle(veri);
          });
        });
      } catch (_) {}
    }

    // 3. HTTP Polling
    if (sunucuDurumu.aktif) {
      if (kanalEtiket) kanalEtiket.textContent = "Yerel Ağ + P2P";
      if (telefon.pollTimer) clearInterval(telefon.pollTimer);
      telefon.pollTimer = setInterval(telefonSunucuYokla, 950);
      telefonMesajGonder("merhaba", { ad: cihazAdiBul() });
    }
  }

  async function telefonSunucuYokla() {
    if (!sunucuDurumu.aktif || !telefon.kod || !telefon.cihazId || document.hidden || aktifGorunum !== "telefon") return;
    try {
      var yanit = await apiPost("/api/tel_durum", {
        kod: telefon.kod,
        cihaz: telefon.cihazId,
        canahtar: telefon.cihazAnahtar,
        son: telefon.sonMesajId
      });
      if (yanit.durum === "kapandi") {
        bildirimGoster("Tahta oturumu sonlandırıldı");
        telefonAltEkranGoster("kod");
        return;
      }
      if (yanit.durum && yanit.durum !== telefon.durum) {
        telefon.durum = yanit.durum;
        var durumMetin = $("tel-baglanti-metin");
        if (durumMetin) {
          durumMetin.textContent = telefon.durum === "onayli"
            ? "Tahtaya bağlısın · Kod: " + kodBiçimle(telefon.kod)
            : "Tahtadan onay bekleniyor…";
        }
      }
      if (typeof yanit.son === "number" && yanit.son > telefon.sonMesajId) {
        telefon.sonMesajId = yanit.son;
      }
      if (Array.isArray(yanit.mesajlar)) {
        for (var i = 0; i < yanit.mesajlar.length; i++) {
          var m = yanit.mesajlar[i];
          telefonHamMesajIsle({
            mesajId: "srv_" + m.id,
            kimden: m.kimden,
            tur: m.tur,
            veri: m.veri
          });
        }
      }
    } catch (_) {}
  }

  function telefonMesajGonder(tur, veri) {
    var paket = {
      mesajId: rastgeleId("m"),
      kimden: telefon.cihazId || "telefon",
      kime: "tahta",
      tur: tur,
      veri: veri || {}
    };

    if (telefon.conn && telefon.conn.open) {
      try { telefon.conn.send(paket); } catch (_) {}
    }

    if (telefon.broadcast) {
      try { telefon.broadcast.postMessage(paket); } catch (_) {}
    }

    if (sunucuDurumu.aktif && telefon.kod) {
      apiPost("/api/mesaj", {
        kod: telefon.kod,
        kimden: telefon.cihazId || "telefon",
        anahtar: telefon.cihazAnahtar,
        kime: "tahta",
        tur: tur,
        veri: veri || {}
      }).catch(function () {});
    }
  }

  async function telefonHamMesajIsle(paket) {
    if (!paket || !paket.tur) return;
    if (paket.kimden && paket.kimden === telefon.cihazId) return;

    var mid = paket.mesajId;
    if (mid) {
      if (telefon.islenenMesajlar.has(mid)) return;
      telefon.islenenMesajlar.add(mid);
    }

    var tur = paket.tur;
    var veri = paket.veri || {};

    if (tur === "tahta-durum-senkron") {
      telefonKumandaDurumGuncelle(veri);
      return;
    }

    if (tur === "sahne-onizleme" && veri.veriUrl) {
      telefonSenkronArkaplanYukle(veri.veriUrl);
      return;
    }

    if (tur === "cizim-temizle") {
      telefonSenkronCizimTemizle(false);
      return;
    }

    if (tur === "tahtadan-dosya-basla") {
      telefon.gelenParcalar[veri.yerel] = {
        meta: veri,
        parcalar: []
      };
      return;
    }

    if (tur === "tahtadan-dosya-parca") {
      var k = telefon.gelenParcalar[veri.yerel];
      if (!k) return;
      k.parcalar.push(veri.veri);
      if (veri.son) {
        var blob = new Blob(k.parcalar, { type: k.meta.tur || "application/octet-stream" });
        delete telefon.gelenParcalar[veri.yerel];
        telefonTahtadanDosyaEkle({
          id: veri.yerel,
          ad: k.meta.ad,
          tur: k.meta.tur,
          boyut: blob.size,
          blob: blob
        });
      }
      return;
    }

    if (tur === "dosya-hazir" && paket.kimden === "tahta") {
      var tekil = veri.yerel || veri.id;
      if (tekil && telefon.islenenDosyalar.has(tekil)) return;
      if (veri.id && sunucuDurumu.aktif) {
        try {
          var yanit = await fetch(
            "/api/dosya_indir?kod=" + encodeURIComponent(telefon.kod) +
            "&id=" + encodeURIComponent(veri.id) +
            "&anahtar=" + encodeURIComponent(telefon.cihazAnahtar)
          );
          if (yanit.ok) {
            var b = await yanit.blob();
            telefonTahtadanDosyaEkle({
              id: tekil,
              ad: veri.ad,
              tur: veri.tur,
              boyut: b.size,
              blob: b
            });
          }
        } catch (_) {}
      }
    }
  }

  /* =========================================================
     TELEFONDAN TAHTAYA DOSYA GÖNDERİMİ
     ========================================================= */
  async function telefonDosyalariGonder(fileList) {
    if (!fileList || fileList.length === 0) return;
    var listeEl = $("tel-gonderilen-listesi");

    for (var i = 0; i < fileList.length; i++) {
      var dosya = fileList[i];
      var yerel = rastgeleId("f");
      var tur = dosyaTuruTahmin(dosya.name, dosya.type);

      var satir = document.createElement("li");
      satir.className = "aktarim-oge";
      satir.innerHTML =
        '<div style="flex:1;min-width:0">' +
          '<div style="font-weight:700;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" class="a-ad"></div>' +
          '<div class="aktarim-cubuk"><i style="width:10%"></i></div>' +
        "</div>" +
        '<span style="font-size:12px;font-weight:700;color:var(--text-muted)" class="a-durum">Gönderiliyor…</span>';
      satir.querySelector(".a-ad").textContent = dosya.name;
      if (listeEl) listeEl.insertBefore(satir, listeEl.firstChild);

      var cubukIc = satir.querySelector(".aktarim-cubuk > i");
      var durumSpan = satir.querySelector(".a-durum");

      try {
        // 1. P2P veya BroadcastChannel açıksa parçalı gönder
        var p2pAktif = (telefon.conn && telefon.conn.open) || Boolean(telefon.broadcast);
        if (p2pAktif) {
          var baslaPaket = {
            mesajId: rastgeleId("m"),
            kimden: telefon.cihazId,
            tur: "dosya-basla",
            veri: { yerel: yerel, ad: dosya.name, tur: tur, boyut: dosya.size }
          };
          if (telefon.conn && telefon.conn.open) telefon.conn.send(baslaPaket);
          if (telefon.broadcast) telefon.broadcast.postMessage(baslaPaket);

          var buf = await dosya.arrayBuffer();
          var parcaBoyut = 32 * 1024;
          for (var ofset = 0; ofset < buf.byteLength; ofset += parcaBoyut) {
            var son = (ofset + parcaBoyut) >= buf.byteLength;
            var dilim = buf.slice(ofset, ofset + parcaBoyut);
            var pPaket = {
              mesajId: rastgeleId("m"),
              kimden: telefon.cihazId,
              tur: "dosya-parca",
              veri: { yerel: yerel, veri: dilim, son: son }
            };
            if (telefon.conn && telefon.conn.open) telefon.conn.send(pPaket);
            if (telefon.broadcast) telefon.broadcast.postMessage(pPaket);
            if (cubukIc) {
              cubukIc.style.width = Math.min(95, Math.round(((ofset + parcaBoyut) / Math.max(1, buf.byteLength)) * 100)) + "%";
            }
          }
        }

        // 2. Yerel sunucu aktifse HTTP üzerinden de garantili yükle (256KB parçalarla)
        if (sunucuDurumu.aktif && telefon.kod) {
          var httpParcaBoyut = 256 * 1024;
          var toplam = Math.max(1, dosya.size);
          for (var hOfset = 0; hOfset < toplam; hOfset += httpParcaBoyut) {
            var hSon = (hOfset + httpParcaBoyut) >= dosya.size;
            var parcaBlob = dosya.slice(hOfset, hOfset + httpParcaBoyut);
            var sorgu =
              "?kod=" + encodeURIComponent(telefon.kod) +
              "&id=" + encodeURIComponent(yerel) +
              "&yerel=" + encodeURIComponent(yerel) +
              "&ad=" + encodeURIComponent(dosya.name) +
              "&tur=" + encodeURIComponent(tur) +
              "&boyut=" + encodeURIComponent(dosya.size) +
              "&kimden=" + encodeURIComponent(telefon.cihazId || "telefon") +
              "&anahtar=" + encodeURIComponent(telefon.cihazAnahtar || "") +
              "&hedef=tahta" +
              "&son=" + (hSon ? "1" : "0");
            await fetch("/api/dosya_yukle" + sorgu, {
              method: "POST",
              body: parcaBlob
            });
            if (cubukIc) {
              cubukIc.style.width = Math.min(100, Math.round(((hOfset + httpParcaBoyut) / toplam) * 100)) + "%";
            }
          }
        }

        if (cubukIc) cubukIc.style.width = "100%";
        if (durumSpan) {
          durumSpan.textContent = "Tahtada Açıldı";
          durumSpan.style.color = "var(--ok)";
        }

        // Eğer resimse telefonun kendi senkron ekranına da hemen yansıt
        if (tur.indexOf("image/") === 0) {
          var yerelUrl = URL.createObjectURL(dosya);
          telefonSenkronArkaplanYukle(yerelUrl);
        }
      } catch (_) {
        if (durumSpan) {
          durumSpan.textContent = "Hata";
          durumSpan.style.color = "var(--danger)";
        }
      }
    }
  }

  /* =========================================================
     TELEFON CANLI EKRAN & TAHTA SENKRON TUVALİ (#sekme-yansit)
     ========================================================= */
  function telefonSenkronTuvalKur() {
    var arkaplan = $("tel-senkron-arkaplan");
    var cizim = $("tel-senkron-cizim");
    var sarma = $("tel-senkron-sarma");
    if (!arkaplan || !cizim || !sarma) return;

    function boyutla() {
      var r = sarma.getBoundingClientRect();
      var w = Math.max(280, Math.floor(r.width || 320));
      var h = Math.max(180, Math.floor(r.height || 220));
      arkaplan.width = w;
      arkaplan.height = h;
      cizim.width = w;
      cizim.height = h;
      telefonSenkronArkaplanCiz();
    }

    window.addEventListener("resize", boyutla);
    setTimeout(boyutla, 120);

    var ciziyor = false;
    var noktalar = [];

    function normAl(ev) {
      var r = cizim.getBoundingClientRect();
      return {
        x: Math.max(0, Math.min(1, (ev.clientX - r.left) / (r.width || 1))),
        y: Math.max(0, Math.min(1, (ev.clientY - r.top) / (r.height || 1)))
      };
    }

    function kalemAyarlari() {
      if (telefon.aktifArac === "kalem-mavi") {
        return { renk: "#38BDF8", kalinlik: 4.5 };
      }
      if (telefon.aktifArac === "fosforlu") {
        return { renk: "rgba(250, 204, 21, 0.42)", kalinlik: 20 };
      }
      return { renk: "#EF4444", kalinlik: 4.5 };
    }

    cizim.addEventListener("pointerdown", function (ev) {
      cizim.setPointerCapture(ev.pointerId);
      ciziyor = true;
      var n = normAl(ev);

      if (telefon.aktifArac === "lazer") {
        telefonMesajGonder("lazer-hareket", n);
        telefonYerelLazerCiz(n.x, n.y);
        return;
      }

      noktalar = [n];
    });

    cizim.addEventListener("pointermove", function (ev) {
      if (!ciziyor) return;
      var n = normAl(ev);

      if (telefon.aktifArac === "lazer") {
        telefonMesajGonder("lazer-hareket", n);
        telefonYerelLazerCiz(n.x, n.y);
        return;
      }

      noktalar.push(n);
      var ctx = cizim.getContext("2d");
      var ayar = kalemAyarlari();
      var son = noktalar[noktalar.length - 2] || n;
      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = ayar.renk;
      ctx.lineWidth = ayar.kalinlik * 0.6;
      ctx.beginPath();
      ctx.moveTo(son.x * cizim.width, son.y * cizim.height);
      ctx.lineTo(n.x * cizim.width, n.y * cizim.height);
      ctx.stroke();
      ctx.restore();
    });

    function bitir() {
      if (!ciziyor) return;
      ciziyor = false;
      if (telefon.aktifArac !== "lazer" && noktalar.length > 0) {
        var ayar = kalemAyarlari();
        telefonMesajGonder("cizim-darbe", {
          arac: telefon.aktifArac,
          renk: ayar.renk,
          kalinlik: ayar.kalinlik,
          noktalar: noktalar
        });
        noktalar = [];
      }
    }

    cizim.addEventListener("pointerup", bitir);
    cizim.addEventListener("pointercancel", bitir);
  }

  function telefonYerelLazerCiz(nx, ny) {
    var cizim = $("tel-senkron-cizim");
    if (!cizim) return;
    var ctx = cizim.getContext("2d");
    ctx.clearRect(0, 0, cizim.width, cizim.height);
    ctx.beginPath();
    ctx.arc(nx * cizim.width, ny * cizim.height, 8, 0, Math.PI * 2);
    ctx.fillStyle = "#EF4444";
    ctx.fill();
  }

  function telefonSenkronArkaplanYukle(veriUrl) {
    var bosBilgi = $("tel-senkron-bos");
    if (bosBilgi) bosBilgi.hidden = true;
    var img = new Image();
    img.onload = function () {
      telefon.arkaplanResim = img;
      telefonSenkronArkaplanCiz();
    };
    img.src = veriUrl;
  }

  function telefonSenkronArkaplanCiz() {
    var arkaplan = $("tel-senkron-arkaplan");
    if (!arkaplan) return;
    var sarma = $("tel-senkron-sarma");
    if (sarma && sarma.clientWidth > 0) {
      arkaplan.width = sarma.clientWidth;
      arkaplan.height = sarma.clientHeight;
      var cizim = $("tel-senkron-cizim");
      if (cizim && (cizim.width !== arkaplan.width || cizim.height !== arkaplan.height)) {
        cizim.width = arkaplan.width;
        cizim.height = arkaplan.height;
      }
    }

    var ctx = arkaplan.getContext("2d");
    var w = arkaplan.width;
    var h = arkaplan.height;
    ctx.clearRect(0, 0, w, h);

    if (!telefon.arkaplanResim) return;
    var img = telefon.arkaplanResim;
    var oran = Math.min(w / img.width, h / img.height);
    var cw = img.width * oran;
    var ch = img.height * oran;
    ctx.drawImage(img, (w - cw) / 2, (h - ch) / 2, cw, ch);
  }

  function telefonSenkronCizimTemizle(gonder) {
    var cizim = $("tel-senkron-cizim");
    if (cizim) {
      cizim.getContext("2d").clearRect(0, 0, cizim.width, cizim.height);
    }
    if (gonder !== false) {
      telefonMesajGonder("cizim-temizle", {});
    }
  }

  /* =========================================================
     TELEFON CANLI KAMERA & CİHAZ EKRANI YAYINI
     ========================================================= */
  async function telefonCanliKameraBaslat() {
    var hataEl = $("tel-canli-hata");
    if (hataEl) hataEl.textContent = "";

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      if (hataEl) {
        hataEl.textContent = "Tarayıcı canlı kamera erişimine izin vermiyor (HTTPS veya localhost gerekir). Dosya Gönder sekmesinden 'Fotoğraf Çek'i kullanabilirsin.";
      }
      return;
    }

    try {
      telefonCanliYayinDurdur(false);
      var akis = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: telefon.kameraYon },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false
      });
      telefonCanliAkisBagla(akis, "Telefon Kamerası (Canlı)");
    } catch (err) {
      if (hataEl) hataEl.textContent = "Kamera açılamadı: " + (err.message || "İzin verilmedi");
    }
  }

  async function telefonCanliEkranBaslat() {
    var hataEl = $("tel-canli-hata");
    if (hataEl) hataEl.textContent = "";

    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== "function") {
      if (hataEl) {
        hataEl.textContent = "Mobil tarayıcılar işletim sistemi kısıtlaması nedeniyle tüm ekran kaydına izin vermez. Yukarıdaki 'Canlı Telefon Ekranı & Tahta Senkronu' alanını veya Canlı Kamerayı kullanabilirsin.";
      }
      return;
    }

    try {
      telefonCanliYayinDurdur(false);
      var akis = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false
      });
      var iz = akis.getVideoTracks()[0];
      if (iz) {
        iz.onended = function () {
          telefonCanliYayinDurdur(true);
        };
      }
      telefonCanliAkisBagla(akis, "Canlı Cihaz Ekranı");
    } catch (err) {
      if (hataEl) hataEl.textContent = "Ekran paylaşımı başlatılamadı.";
    }
  }

  function telefonCanliAkisBagla(akis, etiket) {
    telefon.canliAkis = akis;
    var onizlemeKutu = $("tel-canli-onizleme-kutu");
    var video = $("tel-canli-video");
    if (onizlemeKutu) onizlemeKutu.hidden = false;
    if (video) {
      video.srcObject = akis;
      video.play().catch(function () {});
    }

    // 1. PeerJS WebRTC MediaCall
    if (telefon.peer) {
      try {
        telefon.medyaArama = telefon.peer.call("tahta-at-oda-" + telefon.kod, akis, {
          metadata: { etiket: etiket }
        });
      } catch (_) {}
    }

    // 2. Kare (Frame) Aktarım Yedeği (WebRTC UDP engelli okul ağlarında bile çalışması için)
    var gizliTuval = document.createElement("canvas");
    var gCtx = gizliTuval.getContext("2d");
    if (telefon.kareTimer) clearInterval(telefon.kareTimer);
    telefon.kareTimer = setInterval(function () {
      if (!telefon.canliAkis || !video || video.videoWidth <= 0) return;
      var oran = Math.min(640 / video.videoWidth, 640 / video.videoHeight, 1);
      gizliTuval.width = Math.round(video.videoWidth * oran);
      gizliTuval.height = Math.round(video.videoHeight * oran);
      gCtx.drawImage(video, 0, 0, gizliTuval.width, gizliTuval.height);
      var veriUrl = gizliTuval.toDataURL("image/jpeg", 0.62);
      telefonMesajGonder("canli-kare", { veriUrl: veriUrl, etiket: etiket });
    }, 320);
  }

  function telefonCanliYayinDurdur(bildir) {
    if (telefon.kareTimer) {
      clearInterval(telefon.kareTimer);
      telefon.kareTimer = null;
    }
    if (telefon.medyaArama) {
      try { telefon.medyaArama.close(); } catch (_) {}
      telefon.medyaArama = null;
    }
    if (telefon.canliAkis) {
      telefon.canliAkis.getTracks().forEach(function (t) { t.stop(); });
      telefon.canliAkis = null;
    }
    var video = $("tel-canli-video");
    if (video) video.srcObject = null;
    var kutu = $("tel-canli-onizleme-kutu");
    if (kutu) kutu.hidden = true;
    if (bildir !== false) {
      telefonMesajGonder("canli-kapat", {});
    }
  }

  /* =========================================================
     TELEFON KUMANDA VE TAHTADAN GELENLER GÜNCELLEMESİ
     ========================================================= */
  function telefonKumandaDurumGuncelle(veri) {
    var baslik = $("km-aktif-baslik");
    var alt = $("km-aktif-alt");
    var oynatBtn = $("btn-km-oynat");
    var liste = $("km-dosya-listesi");

    if (baslik) {
      baslik.textContent = veri.aktifAd || "Tahtada açık dosya yok";
    }
    if (alt) {
      if (veri.aktifTur && String(veri.aktifTur).indexOf("pdf") !== -1) {
        alt.textContent = "Sayfa " + (veri.pdfSayfa || 1) + " / " + (veri.pdfToplam || 1);
      } else if (veri.aktifAd) {
        alt.textContent = "Yakınlık: %" + Math.round((veri.yakinlik || 1) * 100);
      } else {
        alt.textContent = "Dosya Gönder sekmesinden bir PDF, fotoğraf veya video seç.";
      }
    }
    if (oynatBtn) {
      var t = String(veri.aktifTur || "");
      oynatBtn.hidden = !(t.indexOf("video/") === 0 || t.indexOf("audio/") === 0);
    }

    if (liste && Array.isArray(veri.dosyalar)) {
      liste.innerHTML = "";
      veri.dosyalar.forEach(function (d) {
        var li = document.createElement("li");
        li.className = "aktarim-oge";
        li.style.cursor = "pointer";
        if (d.aktif) {
          li.style.borderColor = "var(--accent)";
          li.style.background = "var(--accent-soft)";
        }
        var adSpan = document.createElement("span");
        adSpan.style.cssText = "font-weight:700;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
        adSpan.textContent = (d.indeks + 1) + ". " + d.ad;

        var acEtiket = document.createElement("span");
        acEtiket.style.cssText = "font-size:12px;font-weight:800;color:var(--accent)";
        acEtiket.textContent = d.aktif ? "Açık" : "Tahtada Aç";

        li.appendChild(adSpan);
        li.appendChild(acEtiket);
        li.onclick = function () {
          telefonMesajGonder("kumanda", { eylem: "dosya-sec", indeks: d.indeks });
        };
        liste.appendChild(li);
      });
    }
  }

  function telefonDokunmatikPedKur() {
    var ped = $("km-dokunmatik-ped");
    if (!ped) return;

    var basX = 0;
    var basY = 0;
    var sonX = 0;
    var sonY = 0;
    var basZaman = 0;
    var aktif = false;

    ped.addEventListener("pointerdown", function (ev) {
      ped.setPointerCapture(ev.pointerId);
      aktif = true;
      basX = sonX = ev.clientX;
      basY = sonY = ev.clientY;
      basZaman = Date.now();
    });

    ped.addEventListener("pointermove", function (ev) {
      if (!aktif) return;
      var r = ped.getBoundingClientRect();
      var nx = Math.max(0, Math.min(1, (ev.clientX - r.left) / (r.width || 1)));
      var ny = Math.max(0, Math.min(1, (ev.clientY - r.top) / (r.height || 1)));
      telefonMesajGonder("lazer-hareket", { x: nx, y: ny });

      var dx = ev.clientX - sonX;
      var dy = ev.clientY - sonY;
      sonX = ev.clientX;
      sonY = ev.clientY;

      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
        telefonMesajGonder("kumanda", { eylem: "kaydir", dx: dx * 1.4, dy: dy * 1.4 });
      }
    });

    ped.addEventListener("pointerup", function (ev) {
      if (!aktif) return;
      aktif = false;
      var toplamDx = ev.clientX - basX;
      var toplamDy = ev.clientY - basY;
      var gecen = Date.now() - basZaman;

      // Hızlı sağa/sola kaydırma (swipe) ise sayfa değiştir
      if (gecen < 350 && Math.abs(toplamDx) > 55 && Math.abs(toplamDx) > Math.abs(toplamDy) * 1.5) {
        if (toplamDx < 0) {
          telefonMesajGonder("kumanda", { eylem: "ileri" });
        } else {
          telefonMesajGonder("kumanda", { eylem: "geri" });
        }
      }
    });
  }

  function telefonTahtadanDosyaEkle(kayit) {
    if (kayit.id) {
      if (telefon.islenenDosyalar.has(kayit.id)) return;
      telefon.islenenDosyalar.add(kayit.id);
    }

    telefon.tahtadanGelenler.unshift(kayit);
    telefon.okunmamisSayisi++;

    var rozet = $("tel-gelen-rozet");
    if (rozet) {
      rozet.hidden = false;
      rozet.textContent = "(" + telefon.okunmamisSayisi + ")";
    }

    var bos = $("tel-gelen-bos");
    var liste = $("tel-gelen-listesi");
    if (bos) bos.hidden = true;
    if (!liste) return;

    var li = document.createElement("li");
    li.className = "aktarim-oge";
    var sol = document.createElement("div");
    sol.style.cssText = "flex:1;min-width:0";
    var ad = document.createElement("div");
    ad.style.cssText = "font-weight:700;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    ad.textContent = kayit.ad;
    var alt = document.createElement("div");
    alt.style.cssText = "font-size:12px;color:var(--text-muted)";
    alt.textContent = boyutBiçimle(kayit.boyut);
    sol.appendChild(ad);
    sol.appendChild(alt);

    var indirBtn = document.createElement("button");
    indirBtn.className = "dugme kucuk";
    indirBtn.textContent = "İndir";
    indirBtn.onclick = function () {
      blobIndir(kayit.blob, kayit.ad);
    };

    li.appendChild(sol);
    li.appendChild(indirBtn);
    liste.insertBefore(li, liste.firstChild);

    bildirimGoster('Tahtadan "' + kayit.ad + '" geldi');
  }

  /* =========================================================
     OLAY DİNLEYİCİLERİ VE BAŞLATMA
     ========================================================= */
  function olaylariBagla() {
    // 1. GİRİŞ EKRANI OLAYLARI
    var btnTahtaBaslat = $("btn-tahta-baslat");
    if (btnTahtaBaslat) {
      btnTahtaBaslat.onclick = function () {
        history.pushState({}, "", "?ekran=tahta");
        tahtaBaslat();
      };
    }

    var girisKodInput = $("giris-kod-input");
    if (girisKodInput) {
      girisKodInput.addEventListener("input", function () {
        girisKodInput.value = kodBiçimle(girisKodInput.value);
      });
    }

    var girisKodForm = $("giris-kod-form");
    if (girisKodForm) {
      girisKodForm.addEventListener("submit", function (ev) {
        ev.preventDefault();
        var kod = (girisKodInput ? girisKodInput.value : "").replace(/\D/g, "");
        var hata = $("giris-kod-hata");
        if (kod.length !== 6) {
          if (hata) hata.textContent = "Lütfen tahtadaki 6 haneli kodu yaz.";
          return;
        }
        if (hata) hata.textContent = "";
        history.pushState({}, "", "?kod=" + kod);
        telefonGorunumAc(kod);
      });
    }

    // 2. TAHTA EKRANI OLAYLARI
    var cizimBar = $("tahta-cizim-bar");
    if (cizimBar) {
      var aracButonlar = cizimBar.querySelectorAll("[data-arac]");
      aracButonlar.forEach(function (btn) {
        btn.onclick = function () {
          aracButonlar.forEach(function (b) { b.classList.remove("aktif"); });
          btn.classList.add("aktif");
          tahta.aktifArac = btn.getAttribute("data-arac") || "imlec";
          var katman = $("tahta-cizim-katman");
          if (katman) {
            if (tahta.aktifArac === "imlec") {
              katman.classList.remove("cizim-aktif", "etkin");
            } else {
              katman.classList.add("cizim-aktif", "etkin");
            }
          }
        };
      });
    }

    var btnCizimTemizle = $("btn-tahta-cizim-temizle");
    if (btnCizimTemizle) {
      btnCizimTemizle.onclick = function () {
        tahtaCizimTemizle(true);
      };
    }

    var btnBeyazTahta = $("btn-tahta-beyaztahta");
    if (btnBeyazTahta) {
      btnBeyazTahta.onclick = function () {
        tahtaBeyazTahtaAc();
      };
    }

    var toggleQr = function () {
      var bekle = $("tahta-bekle-katman");
      if (bekle) bekle.hidden = !bekle.hidden;
    };
    if ($("btn-qr-ac")) $("btn-qr-ac").onclick = toggleQr;
    if ($("btn-ust-kod")) $("btn-ust-kod").onclick = toggleQr;
    if ($("btn-bekle-kapat")) {
      $("btn-bekle-kapat").onclick = function () {
        var bekle = $("tahta-bekle-katman");
        if (bekle) bekle.hidden = true;
      };
    }

    if ($("btn-tahta-tamekran")) {
      $("btn-tahta-tamekran").onclick = tahtaSunumModuDegistir;
    }
    if ($("btn-sunumdan-cik")) {
      $("btn-sunumdan-cik").onclick = tahtaSunumModuDegistir;
    }

    if ($("btn-dersi-bitir")) {
      $("btn-dersi-bitir").onclick = async function () {
        if (sunucuDurumu.aktif && tahta.kod) {
          await apiPost("/api/oda_kapat", { kod: tahta.kod, anahtar: tahta.anahtar }).catch(function () {});
        }
        sessionStorage.removeItem("tahta_oda_kod");
        sessionStorage.removeItem("tahta_oda_anahtar");
        window.location.href = "?";
      };
    }

    if ($("btn-sahne-onceki")) {
      $("btn-sahne-onceki").onclick = function () {
        tahtaKumandaUygula({ eylem: "geri" });
      };
    }
    if ($("btn-sahne-sonraki")) {
      $("btn-sahne-sonraki").onclick = function () {
        tahtaKumandaUygula({ eylem: "ileri" });
      };
    }
    if ($("btn-sayfa-geri")) {
      $("btn-sayfa-geri").onclick = function () {
        if (tahta.pdfBelge && tahta.pdfSayfa > 1) {
          tahta.pdfSayfa--;
          tahtaPdfSayfaCiz();
        }
      };
    }
    if ($("btn-sayfa-ileri")) {
      $("btn-sayfa-ileri").onclick = function () {
        if (tahta.pdfBelge && tahta.pdfSayfa < tahta.pdfToplam) {
          tahta.pdfSayfa++;
          tahtaPdfSayfaCiz();
        }
      };
    }
    if ($("btn-pdf-sigdir")) {
      $("btn-pdf-sigdir").onclick = function () {
        tahta.pdfSigdir = !tahta.pdfSigdir;
        tahtaPdfSayfaCiz();
      };
    }

    if ($("btn-yakin-eksi")) {
      $("btn-yakin-eksi").onclick = function () { tahtaKumandaUygula({ eylem: "uzaklas" }); };
    }
    if ($("btn-yakin-sifir")) {
      $("btn-yakin-sifir").onclick = function () { tahtaKumandaUygula({ eylem: "sifirla" }); };
    }
    if ($("btn-yakin-arti")) {
      $("btn-yakin-arti").onclick = function () { tahtaKumandaUygula({ eylem: "yakinlas" }); };
    }
    if ($("btn-don-sol")) {
      $("btn-don-sol").onclick = function () { tahtaKumandaUygula({ eylem: "don-sol" }); };
    }
    if ($("btn-don-sag")) {
      $("btn-don-sag").onclick = function () { tahtaKumandaUygula({ eylem: "don-sag" }); };
    }

    if ($("btn-sahne-indir")) {
      $("btn-sahne-indir").onclick = function () {
        var aktif = tahta.dosyalar[tahta.aktifIndeks];
        if (aktif && aktif.blob) blobIndir(aktif.blob, aktif.ad);
      };
    }
    if ($("btn-sahne-telefona")) {
      $("btn-sahne-telefona").onclick = tahtaAcikDosyayiTelefonaGonder;
    }

    // Canlı yayın kontrolleri
    if ($("btn-canli-dondur")) {
      $("btn-canli-dondur").onclick = function () {
        tahta.canliAci = (tahta.canliAci + 90) % 360;
        var v = $("tahta-canli-video");
        var r = $("tahta-canli-resim");
        if (v) v.style.transform = "rotate(" + tahta.canliAci + "deg)";
        if (r) r.style.transform = "rotate(" + tahta.canliAci + "deg)";
      };
    }
    if ($("btn-canli-kare-al")) {
      $("btn-canli-kare-al").onclick = tahtaCanliKareYakala;
    }
    if ($("btn-canli-tamekran")) {
      $("btn-canli-tamekran").onclick = function () {
        var katman = $("tahta-canli-katman");
        if (katman && katman.requestFullscreen) katman.requestFullscreen().catch(function () {});
      };
    }
    if ($("btn-canli-kapat")) {
      $("btn-canli-kapat").onclick = tahtaCanliYayinKapat;
    }

    // Yan panel kontrolleri
    var chkOgrenciModu = $("chk-ogrenci-modu");
    if (chkOgrenciModu) {
      chkOgrenciModu.onchange = function () {
        tahta.ogrenciModu = chkOgrenciModu.checked;
        if (sunucuDurumu.aktif && tahta.kod) {
          apiPost("/api/oda_ayar", {
            kod: tahta.kod,
            anahtar: tahta.anahtar,
            ogrenci_modu: tahta.ogrenciModu
          }).catch(function () {});
        }
      };
    }

    if ($("btn-tumunu-sec")) {
      $("btn-tumunu-sec").onclick = function () {
        var hepsiSecili = tahta.dosyalar.every(function (d) { return d.secili; });
        tahta.dosyalar.forEach(function (d) { d.secili = !hepsiSecili; });
        tahtaDosyaListesiYenileUI();
      };
    }

    if ($("btn-secilenleri-indir")) {
      $("btn-secilenleri-indir").onclick = async function () {
        var secililer = tahta.dosyalar.filter(function (d) { return d.secili && d.blob; });
        if (secililer.length === 0) return;
        if (secililer.length === 1) {
          blobIndir(secililer[0].blob, secililer[0].ad);
          return;
        }
        var zipBlob = await zipBlobOlustur(secililer);
        blobIndir(zipBlob, "tahtaya-at-" + tahta.kod + ".zip");
      };
    }

    var inputTahtadan = $("input-tahtadan-dosya");
    if (inputTahtadan) {
      inputTahtadan.onchange = function () {
        var dosyalar = inputTahtadan.files;
        if (!dosyalar) return;
        for (var i = 0; i < dosyalar.length; i++) {
          var f = dosyalar[i];
          tahtaDosyayiTelefonaGonder(f, f.name, dosyaTuruTahmin(f.name, f.type));
        }
        inputTahtadan.value = "";
      };
    }

    if ($("btn-tahta-ekrangoruntusu")) {
      $("btn-tahta-ekrangoruntusu").onclick = tahtaSahneGoruntusuGonder;
    }

    // Klavye kısayolları (Tahta ekranında sağ/sol ok ile sayfa/dosya geçişi)
    window.addEventListener("keydown", function (ev) {
      if (aktifGorunum !== "tahta") return;
      if (ev.key === "ArrowRight") tahtaKumandaUygula({ eylem: "ileri" });
      else if (ev.key === "ArrowLeft") tahtaKumandaUygula({ eylem: "geri" });
      else if (ev.key === "Escape") {
        var kapsayici = $("gorunum-tahta");
        if (kapsayici && kapsayici.classList.contains("sunum-modu")) {
          tahtaSunumModuDegistir();
        }
      }
    });

    // 3. TELEFON EKRANI OLAYLARI
    var telKodInput = $("tel-kod-input");
    if (telKodInput) {
      telKodInput.addEventListener("input", function () {
        telKodInput.value = kodBiçimle(telKodInput.value);
      });
    }

    var telKodForm = $("tel-kod-form");
    if (telKodForm) {
      telKodForm.addEventListener("submit", function (ev) {
        ev.preventDefault();
        telefonOdayaBaglan(telKodInput ? telKodInput.value : "", "");
      });
    }

    var telAdForm = $("tel-ad-form");
    if (telAdForm) {
      telAdForm.addEventListener("submit", function (ev) {
        ev.preventDefault();
        var adInput = $("tel-ogrenci-ad");
        var ad = adInput ? adInput.value.trim() : "";
        if (ad.length < 2) {
          var h = $("tel-ad-hata");
          if (h) h.textContent = "Lütfen adını yaz.";
          return;
        }
        telefonOdayaBaglan(telefon.kod, ad);
      });
    }

    if ($("btn-baska-tahta")) {
      $("btn-baska-tahta").onclick = function () {
        telefonCanliYayinDurdur(true);
        telefonAltEkranGoster("kod");
      };
    }

    // Telefon Sekmeleri
    var sekmeBar = $("tel-sekme-bar");
    if (sekmeBar) {
      var sekmeButonlar = sekmeBar.querySelectorAll("[data-sekme]");
      sekmeButonlar.forEach(function (btn) {
        btn.onclick = function () {
          var hedef = btn.getAttribute("data-sekme");
          sekmeButonlar.forEach(function (b) { b.classList.remove("aktif"); });
          btn.classList.add("aktif");

          ["gonder", "yansit", "kumanda", "tahtadan"].forEach(function (ad) {
            var el = $("sekme-" + ad);
            if (el) el.hidden = ad !== hedef;
          });

          if (hedef === "yansit") {
            setTimeout(telefonSenkronArkaplanCiz, 60);
          }
          if (hedef === "tahtadan") {
            telefon.okunmamisSayisi = 0;
            var rozet = $("tel-gelen-rozet");
            if (rozet) rozet.hidden = true;
          }
        };
      });
    }

    // Telefon Dosya Seçiciler
    ["input-tel-galeri", "input-tel-belge", "input-tel-kamera"].forEach(function (id) {
      var inp = $(id);
      if (inp) {
        inp.onchange = function () {
          telefonDosyalariGonder(inp.files);
          inp.value = "";
        };
      }
    });

    var telLinkForm = $("tel-link-form");
    if (telLinkForm) {
      telLinkForm.addEventListener("submit", function (ev) {
        ev.preventDefault();
        var inp = $("tel-link-input");
        var hata = $("tel-link-hata");
        var ham = inp ? inp.value.trim() : "";
        if (!ham) return;
        if (!/^https?:\/\//i.test(ham)) ham = "https://" + ham;
        try {
          new URL(ham);
        } catch (_) {
          if (hata) hata.textContent = "Geçerli bir bağlantı adresi yaz.";
          return;
        }
        if (hata) hata.textContent = "";
        telefonMesajGonder("baglanti-gonder", {
          yerel: rastgeleId("lnk"),
          url: ham,
          baslik: ham
        });
        if (inp) inp.value = "";
        bildirimGoster("Bağlantı tahtada açıldı");
      });
    }

    // Telefon Canlı Ekran Senkron Araçları
    var telCizimBar = $("tel-cizim-araclari");
    if (telCizimBar) {
      var telAraclar = telCizimBar.querySelectorAll("[data-tel-arac]");
      telAraclar.forEach(function (btn) {
        btn.onclick = function () {
          telAraclar.forEach(function (b) { b.classList.remove("aktif"); });
          btn.classList.add("aktif");
          telefon.aktifArac = btn.getAttribute("data-tel-arac") || "lazer";
        };
      });
    }

    if ($("btn-tel-cizim-temizle")) {
      $("btn-tel-cizim-temizle").onclick = function () {
        telefonSenkronCizimTemizle(true);
      };
    }

    if ($("btn-tel-beyaztahta")) {
      $("btn-tel-beyaztahta").onclick = function () {
        var bos = $("tel-senkron-bos");
        if (bos) bos.hidden = true;
        var beyazTuval = document.createElement("canvas");
        beyazTuval.width = 640;
        beyazTuval.height = 360;
        var bCtx = beyazTuval.getContext("2d");
        bCtx.fillStyle = "#FFFFFF";
        bCtx.fillRect(0, 0, 640, 360);
        telefonSenkronArkaplanYukle(beyazTuval.toDataURL("image/png"));
        telefonMesajGonder("beyaz-tahta-ac", {});
      };
    }

    if ($("btn-senkron-geri")) {
      $("btn-senkron-geri").onclick = function () {
        telefonMesajGonder("kumanda", { eylem: "geri" });
      };
    }
    if ($("btn-senkron-ileri")) {
      $("btn-senkron-ileri").onclick = function () {
        telefonMesajGonder("kumanda", { eylem: "ileri" });
      };
    }

    // Telefon Canlı Kamera ve Ekran Butonları
    if ($("btn-tel-canli-kamera")) {
      $("btn-tel-canli-kamera").onclick = telefonCanliKameraBaslat;
    }
    if ($("btn-tel-canli-ekran")) {
      $("btn-tel-canli-ekran").onclick = telefonCanliEkranBaslat;
    }
    if ($("btn-tel-kamera-cevir")) {
      $("btn-tel-kamera-cevir").onclick = function () {
        telefon.kameraYon = telefon.kameraYon === "environment" ? "user" : "environment";
        telefonCanliKameraBaslat();
      };
    }
    if ($("btn-tel-kare-yakala")) {
      $("btn-tel-kare-yakala").onclick = function () {
        telefonMesajGonder("canli-kare-yakala", {});
        bildirimGoster("Görüntü tahtada fotoğraf olarak yakalandı");
      };
    }
    if ($("btn-tel-canli-durdur")) {
      $("btn-tel-canli-durdur").onclick = function () {
        telefonCanliYayinDurdur(true);
      };
    }

    // Telefon Kumanda Butonları
    if ($("btn-km-geri")) {
      $("btn-km-geri").onclick = function () { telefonMesajGonder("kumanda", { eylem: "geri" }); };
    }
    if ($("btn-km-ileri")) {
      $("btn-km-ileri").onclick = function () { telefonMesajGonder("kumanda", { eylem: "ileri" }); };
    }
    if ($("btn-km-uzaklas")) {
      $("btn-km-uzaklas").onclick = function () { telefonMesajGonder("kumanda", { eylem: "uzaklas" }); };
    }
    if ($("btn-km-yuzde")) {
      $("btn-km-yuzde").onclick = function () { telefonMesajGonder("kumanda", { eylem: "sifirla" }); };
    }
    if ($("btn-km-yakinlas")) {
      $("btn-km-yakinlas").onclick = function () { telefonMesajGonder("kumanda", { eylem: "yakinlas" }); };
    }
    if ($("btn-km-donsol")) {
      $("btn-km-donsol").onclick = function () { telefonMesajGonder("kumanda", { eylem: "don-sol" }); };
    }
    if ($("btn-km-donsag")) {
      $("btn-km-donsag").onclick = function () { telefonMesajGonder("kumanda", { eylem: "don-sag" }); };
    }
    if ($("btn-km-oynat")) {
      $("btn-km-oynat").onclick = function () { telefonMesajGonder("kumanda", { eylem: "oynat-durdur" }); };
    }
    if ($("btn-km-sunum")) {
      $("btn-km-sunum").onclick = function () { telefonMesajGonder("kumanda", { eylem: "sunum-modu" }); };
    }
    if ($("btn-km-qr")) {
      $("btn-km-qr").onclick = function () { telefonMesajGonder("kumanda", { eylem: "qr-ac-kapat" }); };
    }
    if ($("btn-km-telefona-al")) {
      $("btn-km-telefona-al").onclick = function () {
        telefonMesajGonder("sahne-telefona-iste", {});
        bildirimGoster("Tahtadaki dosya telefonuna isteniyor…");
      };
    }

    // 4. HESAP / GİRİŞ VE KAYIT OLAYLARI
    if ($("btn-ust-giris")) {
      $("btn-ust-giris").onclick = function () {
        history.pushState({}, "", "?ekran=giris");
        hesapGorunumAc("giris");
      };
    }
    if ($("btn-ust-kayit")) {
      $("btn-ust-kayit").onclick = function () {
        history.pushState({}, "", "?ekran=kayit");
        hesapGorunumAc("kayit");
      };
    }
    if ($("btn-tel-hesap")) {
      $("btn-tel-hesap").onclick = function () {
        hesapGorunumAc(kullaniciDurumu.kullanici ? "giris" : "kayit");
      };
    }
    if ($("btn-hesap-geri")) {
      $("btn-hesap-geri").onclick = function () {
        history.pushState({}, "", "?");
        gorunumGoster("giris");
      };
    }
    if ($("sekme-btn-giris")) {
      $("sekme-btn-giris").onclick = function () { hesapGorunumAc("giris"); };
    }
    if ($("sekme-btn-kayit")) {
      $("sekme-btn-kayit").onclick = function () { hesapGorunumAc("kayit"); };
    }
    if ($("btn-hesap-hizli-tahta")) {
      $("btn-hesap-hizli-tahta").onclick = function () {
        history.pushState({}, "", "?ekran=tahta");
        tahtaBaslat();
      };
    }
    if ($("btn-hesap-hizli-kod")) {
      $("btn-hesap-hizli-kod").onclick = function () {
        history.pushState({}, "", "?ekran=telefon");
        telefonGorunumAc("");
      };
    }

    if ($("btn-ust-cikis")) {
      $("btn-ust-cikis").onclick = async function () {
        if (sunucuDurumu.aktif) {
          await apiPost("/api/cikis", {}).catch(function () {});
        }
        kullaniciDurumu.kullanici = null;
        kullaniciDurumu.token = "";
        localStorage.removeItem("tahta_oturum_token");
        localStorage.removeItem("tahta_aktif_kullanici");
        kullaniciArayuzGuncelle();
        bildirimGoster("Hesaptan çıkış yapıldı");
      };
    }

    async function webCryptoPbkdf2(sifre, tuzHex) {
      var enc = new TextEncoder();
      var tuzBytes;
      if (tuzHex) {
        tuzBytes = new Uint8Array(tuzHex.length / 2);
        for (var i = 0; i < tuzBytes.length; i++) {
          tuzBytes[i] = parseInt(tuzHex.substr(i * 2, 2), 16);
        }
      } else {
        tuzBytes = new Uint8Array(16);
        window.crypto.getRandomValues(tuzBytes);
        tuzHex = Array.from(tuzBytes).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
      }
      var anahtarMateryal = await window.crypto.subtle.importKey(
        "raw",
        enc.encode(sifre),
        { name: "PBKDF2" },
        false,
        ["deriveBits"]
      );
      var bitler = await window.crypto.subtle.deriveBits(
        { name: "PBKDF2", salt: tuzBytes, iterations: 100000, hash: "SHA-256" },
        anahtarMateryal,
        256
      );
      var ozetHex = Array.from(new Uint8Array(bitler)).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
      return { tuz: tuzHex, ozet: ozetHex };
    }

    // Şifre göster/gizle düğmeleri
    document.querySelectorAll(".sifre-goster-btn").forEach(function (btn) {
      btn.onclick = function () {
        var hedefId = btn.getAttribute("data-hedef");
        var inp = $(hedefId);
        if (!inp) return;
        var gizliMi = inp.type === "password";
        inp.type = gizliMi ? "text" : "password";
        btn.textContent = gizliMi ? "Gizle" : "Göster";
      };
    });

    // Canlı şifre gücü göstergesi
    var kayitSifreInput = $("kayit-sifre");
    if (kayitSifreInput) {
      kayitSifreInput.addEventListener("input", function () {
        var s = kayitSifreInput.value || "";
        var puan = 0;
        if (s.length >= 8) puan += 40;
        if (s.length >= 12) puan += 20;
        if (/[A-Z]/.test(s) && /[a-z]/.test(s)) puan += 20;
        if (/\d/.test(s) || /[^A-Za-z0-9]/.test(s)) puan += 20;
        var ic = $("sifre-guc-ic");
        var yazi = $("sifre-guc-yazi");
        if (ic) {
          ic.style.width = puan + "%";
          ic.style.background = puan < 50 ? "var(--danger)" : (puan < 80 ? "#F59E0B" : "var(--ok)");
        }
        if (yazi) {
          yazi.textContent = s.length < 8
            ? "En az 8 karakter gerekli (" + s.length + "/8)"
            : (puan >= 80 ? "Güçlü şifre" : "Orta güçte şifre");
        }
      });
    }

    // Giriş Formu Gönderimi
    var formHesapGiris = $("form-hesap-giris");
    if (formHesapGiris) {
      formHesapGiris.addEventListener("submit", async function (ev) {
        ev.preventDefault();
        var kadi = ($("giris-kadi") ? $("giris-kadi").value : "").trim();
        var sifre = $("giris-sifre") ? $("giris-sifre").value : "";
        var hataEl = $("form-giris-hata");
        if (hataEl) hataEl.textContent = "";

        if (kadi.length < 3 || sifre.length < 8) {
          if (hataEl) hataEl.textContent = "Kullanıcı adı (en az 3) ve şifreni (en az 8 karakter) gir.";
          return;
        }

        try {
          var yanit;
          if (sunucuDurumu.aktif) {
            yanit = await apiPost("/api/giris", {
              kullanici_adi: kadi,
              sifre: sifre
            });
          } else {
            var depo = JSON.parse(localStorage.getItem("tahta_hesaplar_v1") || "{}");
            var kayit = depo[kadi.toLowerCase()];
            if (!kayit) throw new Error("Kullanıcı adı/e-posta veya şifre hatalı.");
            var dogrulama = await webCryptoPbkdf2(sifre, kayit.tuz);
            if (dogrulama.ozet !== kayit.ozet) throw new Error("Kullanıcı adı/e-posta veya şifre hatalı.");
            yanit = {
              kullanici: { id: kayit.id, kadi: kayit.kadi, ad: kayit.ad, kurum: kayit.kurum },
              token: rastgeleId("tok")
            };
          }
          kullaniciDurumu.kullanici = yanit.kullanici;
          kullaniciDurumu.token = yanit.token || "";
          if (kullaniciDurumu.token) {
            localStorage.setItem("tahta_oturum_token", kullaniciDurumu.token);
          }
          localStorage.setItem("tahta_aktif_kullanici", JSON.stringify(yanit.kullanici));
          kullaniciArayuzGuncelle();
          bildirimGoster("Hoş geldin, " + (yanit.kullanici.ad || kadi));
          history.pushState({}, "", "?");
          gorunumGoster("giris");
        } catch (err) {
          if (hataEl) hataEl.textContent = err.message || "Giriş yapılamadı.";
        }
      });
    }

    // Kayıt Formu Gönderimi
    var formHesapKayit = $("form-hesap-kayit");
    if (formHesapKayit) {
      formHesapKayit.addEventListener("submit", async function (ev) {
        ev.preventDefault();
        var ad = ($("kayit-ad") ? $("kayit-ad").value : "").trim();
        var kadi = ($("kayit-kadi") ? $("kayit-kadi").value : "").trim();
        var kurum = ($("kayit-kurum") ? $("kayit-kurum").value : "").trim();
        var sifre = $("kayit-sifre") ? $("kayit-sifre").value : "";
        var sifreTekrar = $("kayit-sifre-tekrar") ? $("kayit-sifre-tekrar").value : "";
        var hataEl = $("form-kayit-hata");
        if (hataEl) hataEl.textContent = "";

        if (ad.length < 2) {
          if (hataEl) hataEl.textContent = "Lütfen ad ve soyadını yaz.";
          return;
        }
        if (kadi.length < 3 || !/^[a-zA-Z0-9._@-]{3,60}$/.test(kadi)) {
          if (hataEl) hataEl.textContent = "Kullanıcı adı veya e-posta geçersiz (en az 3 karakter).";
          return;
        }
        if (sifre.length < 8) {
          if (hataEl) hataEl.textContent = "Şifre en az 8 karakter olmalıdır.";
          return;
        }
        if (sifre !== sifreTekrar) {
          if (hataEl) hataEl.textContent = "Girilen şifreler birbiriyle eşleşmiyor.";
          return;
        }

        try {
          var yanit;
          if (sunucuDurumu.aktif) {
            yanit = await apiPost("/api/kayit", {
              ad_soyad: ad,
              kullanici_adi: kadi,
              kurum: kurum,
              sifre: sifre
            });
          } else {
            var depo = JSON.parse(localStorage.getItem("tahta_hesaplar_v1") || "{}");
            var anahtar = kadi.toLowerCase();
            if (depo[anahtar]) throw new Error("Bu kullanıcı adı veya e-posta zaten kayıtlı.");
            var kripto = await webCryptoPbkdf2(sifre, null);
            var yeniK = {
              id: rastgeleId("u"),
              kadi: anahtar,
              ad: ad,
              kurum: kurum,
              tuz: kripto.tuz,
              ozet: kripto.ozet
            };
            depo[anahtar] = yeniK;
            localStorage.setItem("tahta_hesaplar_v1", JSON.stringify(depo));
            yanit = {
              kullanici: { id: yeniK.id, kadi: yeniK.kadi, ad: yeniK.ad, kurum: yeniK.kurum },
              token: rastgeleId("tok")
            };
          }
          kullaniciDurumu.kullanici = yanit.kullanici;
          kullaniciDurumu.token = yanit.token || "";
          if (kullaniciDurumu.token) {
            localStorage.setItem("tahta_oturum_token", kullaniciDurumu.token);
          }
          localStorage.setItem("tahta_aktif_kullanici", JSON.stringify(yanit.kullanici));
          kullaniciArayuzGuncelle();
          bildirimGoster("Hesabın oluşturuldu, hoş geldin " + yanit.kullanici.ad);
          history.pushState({}, "", "?");
          gorunumGoster("giris");
        } catch (err) {
          if (hataEl) hataEl.textContent = err.message || "Hesap oluşturulamadı.";
        }
      });
    }
  }

  function baslangicRotaBelirle() {
    kullaniciArayuzGuncelle();
    sunucuBilgisiKontrolEt();
    var sorgu = new URLSearchParams(window.location.search);
    var ekran = sorgu.get("ekran") || "";
    var kod = sorgu.get("kod") || "";
    var yol = window.location.pathname || "/";

    if (yol === "/giris" || ekran === "giris") {
      hesapGorunumAc("giris");
      return;
    }

    if (yol === "/kayit" || ekran === "kayit") {
      hesapGorunumAc("kayit");
      return;
    }

    if (yol === "/tahta" || ekran === "tahta") {
      tahtaBaslat();
      return;
    }

    var gKodEslesme = yol.match(/\/g\/(\d{6})/);
    if (gKodEslesme && gKodEslesme[1]) {
      telefonGorunumAc(gKodEslesme[1]);
      return;
    }

    if (kod) {
      telefonGorunumAc(kod);
      return;
    }

    if (yol === "/gonder" || ekran === "telefon") {
      telefonGorunumAc("");
      return;
    }

    gorunumGoster("giris");
  }

  document.addEventListener("DOMContentLoaded", function () {
    olaylariBagla();
    baslangicRotaBelirle();
  });
})();
