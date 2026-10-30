const crypto = require("crypto");

const ODA_OMRU_MS = 6 * 3600 * 1000;
const OTURUM_OMRU_SN = 30 * 86400;
const MAKS_DOSYA_BOYUT = 4.2 * 1024 * 1024; // Vercel Serverless body sınırı (4.5MB)
const MAKS_ODA_BELLEK = 40 * 1024 * 1024;
const PBKDF2_ITERASYON = 120000;

const GIZLI_ANAHTAR = process.env.TAHTA_GIZLI_ANAHTAR || "tahtaya-at-hmac-v1-9f8e7d6c5b4a3f2e1d0c";

const INDIRME_ZORUNLU_TURLER = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "application/javascript",
  "text/javascript",
  "application/x-javascript"
]);

// Warm container belleği (fra1 bölgesinde paylaşılır + imzalı token ile cold-start korumalı)
const globalBellek = globalThis.__TAHTAYA_AT_BELLEK__ || (globalThis.__TAHTAYA_AT_BELLEK__ = {
  kullanicilar: new Map(),
  odalar: new Map(),
  hizSiniri: new Map()
});

function hizIzniVarMi(anahtar, limit, pencereSn) {
  const simdi = Date.now();
  const pencereMs = pencereSn * 1000;
  let gecmis = globalBellek.hizSiniri.get(anahtar) || [];
  gecmis = gecmis.filter((z) => simdi - z < pencereMs);
  if (gecmis.length >= limit) {
    globalBellek.hizSiniri.set(anahtar, gecmis);
    return false;
  }
  gecmis.push(simdi);
  globalBellek.hizSiniri.set(anahtar, gecmis);
  return true;
}

function guvenliEsitMi(a, b) {
  const sa = String(a || "");
  const sb = String(b || "");
  if (sa.length === 0 || sa.length !== sb.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(sa, "utf8"), Buffer.from(sb, "utf8"));
  } catch (_) {
    return false;
  }
}

function hmacHesapla(metin) {
  return crypto.createHmac("sha256", GIZLI_ANAHTAR).update(String(metin), "utf8").digest("hex");
}

function odaAnahtariUret(kod) {
  return hmacHesapla("oda-anahtar:" + kod);
}

function qrJetonUret(kod) {
  return hmacHesapla("oda-qr:" + kod).slice(0, 24);
}

function cihazAnahtariUret(kod, cid) {
  return hmacHesapla("cihaz:" + kod + ":" + cid).slice(0, 32);
}

function sifreOzetle(sifre, tuzHex) {
  const tuz = tuzHex ? Buffer.from(tuzHex, "hex") : crypto.randomBytes(16);
  const ozet = crypto.pbkdf2Sync(String(sifre), tuz, PBKDF2_ITERASYON, 32, "sha256");
  return { tuz: tuz.toString("hex"), ozet: ozet.toString("hex") };
}

function oturumTokenUret(k) {
  const veri = {
    uid: k.id,
    kadi: k.kullanici_adi,
    ad: k.ad_soyad,
    kurum: k.kurum || "",
    son: Math.floor(Date.now() / 1000) + OTURUM_OMRU_SN
  };
  const govde = Buffer.from(JSON.stringify(veri), "utf8").toString("hex");
  const imza = hmacHesapla(govde);
  return govde + "." + imza;
}

function oturumTokenCoz(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  try {
    const [govde, imza] = token.split(".", 2);
    if (!guvenliEsitMi(imza, hmacHesapla(govde))) return null;
    const veri = JSON.parse(Buffer.from(govde, "hex").toString("utf8"));
    if (!veri || Number(veri.son || 0) < Math.floor(Date.now() / 1000)) return null;
    return veri;
  } catch (_) {
    return null;
  }
}

function cerezdenTokenAl(req) {
  const baslikToken = (req.headers["x-oturum-token"] || "").toString().trim();
  if (baslikToken) return baslikToken;
  const cerez = req.headers.cookie || "";
  const eslesme = cerez.match(/(?:^|;\s*)tahta_oturum=([^;]+)/);
  return eslesme ? decodeURIComponent(eslesme[1].trim()) : "";
}

function odaOlusturVeyaGetir(kod, sahipId = "") {
  let oda = globalBellek.odalar.get(kod);
  if (!oda) {
    oda = {
      kod,
      sahip_id: sahipId,
      anahtar: odaAnahtariUret(kod),
      qr_jeton: qrJetonUret(kod),
      olusturma: Date.now(),
      son_etkinlik: Date.now(),
      ogrenci_modu: false,
      kapandi: false,
      toplam_bellek: 0,
      cihazlar: new Map(),
      mesajlar: [],
      dosyalar: new Map(),
      sayac: 0
    };
    globalBellek.odalar.set(kod, oda);
  }
  return oda;
}

function odaMesajEkle(oda, kimden, kime, tur, veri) {
  oda.sayac += 1;
  oda.son_etkinlik = Date.now();
  oda.mesajlar.push({
    id: oda.sayac,
    kimden,
    kime,
    tur: String(tur || "").slice(0, 48),
    veri: veri || {},
    zaman: Date.now() / 1000
  });
  if (oda.mesajlar.length > 400) {
    oda.mesajlar = oda.mesajlar.slice(-250);
  }
  return oda.sayac;
}

function gondericiYetkiliMi(oda, kimden, anahtar) {
  if (!anahtar) return false;
  if (kimden === "tahta" && guvenliEsitMi(oda.anahtar, anahtar)) return true;
  const c = oda.cihazlar.get(kimden);
  if (c && c.durum === "onayli" && guvenliEsitMi(c.anahtar, anahtar)) return true;
  // Cold-start sonrası deterministik cihaz anahtarı doğrulaması
  if (kimden && guvenliEsitMi(cihazAnahtariUret(oda.kod, kimden), anahtar)) {
    if (!c) {
      oda.cihazlar.set(kimden, {
        id: kimden,
        ad: "Telefon",
        rol: "ogretmen",
        durum: "onayli",
        anahtar,
        son_gorulme: Date.now()
      });
    }
    return true;
  }
  return false;
}

function hamGovdeOku(req, maksBoyut) {
  return new Promise((resolve, reject) => {
    const parcalar = [];
    let toplam = 0;
    req.on("data", (p) => {
      toplam += p.length;
      if (toplam > maksBoyut) {
        reject(new Error("BOYUT_ASILDI"));
        req.destroy();
        return;
      }
      parcalar.push(p);
    });
    req.on("end", () => resolve(Buffer.concat(parcalar)));
    req.on("error", reject);
  });
}

function jsonYanit(res, durum, veri, ekBasliklar = {}) {
  res.statusCode = durum;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  for (const [k, v] of Object.entries(ekBasliklar)) {
    res.setHeader(k, v);
  }
  res.end(JSON.stringify(veri));
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  const tamUrl = new URL(req.url, `https://${req.headers.host || "localhost"}`);
  const yol = tamUrl.pathname;
  const ip = (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "0.0.0.0").toString().split(",")[0].trim();
  const oturum = oturumTokenCoz(cerezdenTokenAl(req));

  // Eski odaları temizle
  const simdi = Date.now();
  for (const [k, o] of globalBellek.odalar.entries()) {
    if (simdi - o.son_etkinlik > ODA_OMRU_MS || o.kapandi) {
      globalBellek.odalar.delete(k);
    }
  }

  if (req.method === "GET") {
    if (yol === "/api/bilgi") {
      const proto = req.headers["x-forwarded-proto"] || "https";
      const host = req.headers.host || "localhost";
      return jsonYanit(res, 200, {
        sunucu: "tahta-at-bulut",
        ip: host,
        ipler: [host],
        adres: `${proto}://${host}`,
        kullanici: oturum
      });
    }

    if (yol === "/api/oturum") {
      return jsonYanit(res, 200, { kullanici: oturum });
    }

    if (yol === "/api/dosya_indir") {
      const kod = tamUrl.searchParams.get("kod") || "";
      const did = tamUrl.searchParams.get("id") || "";
      const anahtar = tamUrl.searchParams.get("anahtar") || req.headers["x-gonderen-anahtar"] || "";
      const oda = globalBellek.odalar.get(kod);
      if (!oda || oda.kapandi) {
        return jsonYanit(res, 404, { hata: "Oda bulunamadı" });
      }
      const yetkili =
        guvenliEsitMi(oda.anahtar, anahtar) ||
        Array.from(oda.cihazlar.values()).some((c) => c.durum === "onayli" && guvenliEsitMi(c.anahtar, anahtar));
      if (!yetkili) {
        return jsonYanit(res, 403, { hata: "Bu dosyayı indirme yetkiniz yok" });
      }
      const dosya = oda.dosyalar.get(did);
      if (!dosya || !dosya.tamam) {
        return jsonYanit(res, 404, { hata: "Dosya bulunamadı" });
      }
      const hamTur = (dosya.tur || "application/octet-stream").split(";")[0].trim().toLowerCase();
      const guvenliTur = INDIRME_ZORUNLU_TURLER.has(hamTur) ? "application/octet-stream" : hamTur;
      const birlesik = Buffer.concat(dosya.parcalar);
      res.statusCode = 200;
      res.setHeader("Content-Type", guvenliTur);
      res.setHeader("Content-Length", String(birlesik.length));
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Disposition", `attachment; filename="${dosya.ad}"`);
      res.end(birlesik);
      return;
    }

    return jsonYanit(res, 404, { hata: "Uç nokta bulunamadı" });
  }

  if (req.method === "POST") {
    if (yol === "/api/dosya_yukle") {
      if (!hizIzniVarMi(`yukle:${ip}`, 180, 60)) {
        return jsonYanit(res, 429, { hata: "Çok fazla yükleme isteği." });
      }
      const kod = tamUrl.searchParams.get("kod") || "";
      const did = tamUrl.searchParams.get("id") || "d_" + crypto.randomBytes(6).toString("hex");
      const yerel = tamUrl.searchParams.get("yerel") || did;
      const adHam = tamUrl.searchParams.get("ad") || "dosya";
      const ad = adHam.replace(/[\x00-\x1f\\/:*?"<>|]/g, "_").slice(0, 180) || "dosya";
      const tur = tamUrl.searchParams.get("tur") || "application/octet-stream";
      const boyut = Number(tamUrl.searchParams.get("boyut") || 0);
      const kimden = tamUrl.searchParams.get("kimden") || "";
      const anahtar = tamUrl.searchParams.get("anahtar") || req.headers["x-gonderen-anahtar"] || "";
      const hedef = tamUrl.searchParams.get("hedef") || "tahta";
      const sonParca = (tamUrl.searchParams.get("son") || "1") === "1";

      let parcaBuf;
      try {
        parcaBuf = Buffer.isBuffer(req.body)
          ? req.body
          : typeof req.body === "string"
            ? Buffer.from(req.body)
            : await hamGovdeOku(req, MAKS_DOSYA_BOYUT);
      } catch (_) {
        return jsonYanit(res, 413, { hata: "Dosya parçası boyutu çok büyük." });
      }

      const oda = odaOlusturVeyaGetir(kod);
      if (!gondericiYetkiliMi(oda, kimden, anahtar)) {
        return jsonYanit(res, 403, { hata: "Dosya yükleme yetkiniz yok." });
      }
      if (oda.toplam_bellek + parcaBuf.length > MAKS_ODA_BELLEK) {
        return jsonYanit(res, 413, { hata: "Oda bellek sınırı aşıldı." });
      }

      let kayit = oda.dosyalar.get(did);
      if (!kayit) {
        kayit = { id: did, yerel, ad, tur, boyut, kimden, hedef, parcalar: [], alinan: 0, tamam: false };
        oda.dosyalar.set(did, kayit);
      }
      kayit.parcalar.push(parcaBuf);
      kayit.alinan += parcaBuf.length;
      oda.toplam_bellek += parcaBuf.length;

      if (sonParca) {
        kayit.tamam = true;
        kayit.boyut = kayit.alinan;
        odaMesajEkle(oda, kimden, hedef, "dosya-hazir", {
          id: kayit.id,
          yerel: kayit.yerel,
          ad: kayit.ad,
          tur: kayit.tur,
          boyut: kayit.boyut,
          kimden
        });
      }
      return jsonYanit(res, 200, { id: did, alindi: kayit.alinan, tamam: sonParca });
    }

    let veri = {};
    if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
      veri = req.body;
    } else {
      try {
        const ham = Buffer.isBuffer(req.body) ? req.body : await hamGovdeOku(req, 256 * 1024);
        veri = JSON.parse(ham.toString("utf8") || "{}");
      } catch (_) {
        veri = {};
      }
    }

    // --- KULLANICI KAYIT (/api/kayit) ---
    if (yol === "/api/kayit") {
      if (!hizIzniVarMi(`kayit:${ip}`, 8, 300)) {
        return jsonYanit(res, 429, { hata: "Çok fazla kayıt denemesi. 5 dakika bekleyin." });
      }
      const adSoyad = String(veri.ad_soyad || "").trim().slice(0, 60);
      const kadi = String(veri.kullanici_adi || "").trim().toLowerCase().slice(0, 60);
      const kurum = String(veri.kurum || "").trim().slice(0, 80);
      const sifre = String(veri.sifre || "");

      if (adSoyad.length < 2) {
        return jsonYanit(res, 400, { hata: "Ad ve soyad en az 2 karakter olmalıdır." });
      }
      if (!/^[a-z0-9._@-]{3,60}$/.test(kadi)) {
        return jsonYanit(res, 400, { hata: "Kullanıcı adı veya e-posta geçersiz (en az 3 karakter)." });
      }
      if (sifre.length < 8 || sifre.length > 128) {
        return jsonYanit(res, 400, { hata: "Şifre en az 8 karakter olmalıdır." });
      }
      if (globalBellek.kullanicilar.has(kadi)) {
        return jsonYanit(res, 409, { hata: "Bu kullanıcı adı veya e-posta zaten kayıtlı." });
      }

      const { tuz, ozet } = sifreOzetle(sifre);
      const yeniK = {
        id: "u_" + crypto.randomBytes(8).toString("hex"),
        kullanici_adi: kadi,
        ad_soyad: adSoyad,
        kurum,
        tuz,
        ozet
      };
      globalBellek.kullanicilar.set(kadi, yeniK);

      const token = oturumTokenUret(yeniK);
      const cerez = `tahta_oturum=${token}; Path=/; Max-Age=${OTURUM_OMRU_SN}; HttpOnly; Secure; SameSite=Strict`;
      return jsonYanit(res, 200, {
        kullanici: { id: yeniK.id, kadi: yeniK.kullanici_adi, ad: yeniK.ad_soyad, kurum: yeniK.kurum },
        token
      }, { "Set-Cookie": cerez });
    }

    // --- KULLANICI GİRİŞ (/api/giris) ---
    if (yol === "/api/giris") {
      if (!hizIzniVarMi(`giris:${ip}`, 10, 300)) {
        return jsonYanit(res, 429, { hata: "Çok fazla başarısız giriş denemesi. 5 dakika bekleyin." });
      }
      const kadi = String(veri.kullanici_adi || "").trim().toLowerCase().slice(0, 60);
      const sifre = String(veri.sifre || "");
      const kayit = globalBellek.kullanicilar.get(kadi);

      if (!kayit) {
        return jsonYanit(res, 401, { hata: "Kullanıcı adı/e-posta veya şifre hatalı." });
      }
      const { ozet } = sifreOzetle(sifre, kayit.tuz);
      if (!guvenliEsitMi(ozet, kayit.ozet)) {
        return jsonYanit(res, 401, { hata: "Kullanıcı adı/e-posta veya şifre hatalı." });
      }

      const token = oturumTokenUret(kayit);
      const cerez = `tahta_oturum=${token}; Path=/; Max-Age=${OTURUM_OMRU_SN}; HttpOnly; Secure; SameSite=Strict`;
      return jsonYanit(res, 200, {
        kullanici: { id: kayit.id, kadi: kayit.kullanici_adi, ad: kayit.ad_soyad, kurum: kayit.kurum },
        token
      }, { "Set-Cookie": cerez });
    }

    // --- ÇIKIŞ (/api/cikis) ---
    if (yol === "/api/cikis") {
      const cerez = "tahta_oturum=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict";
      return jsonYanit(res, 200, { cikis: true }, { "Set-Cookie": cerez });
    }

    // --- ODA AÇ (/api/oda_ac) ---
    if (yol === "/api/oda_ac") {
      const istenenKod = String(veri.kod || "").trim();
      const istenenAnahtar = String(veri.anahtar || "").trim();
      if (/^\d{6}$/.test(istenenKod) && guvenliEsitMi(odaAnahtariUret(istenenKod), istenenAnahtar)) {
        const mevcut = odaOlusturVeyaGetir(istenenKod, oturum ? oturum.uid : "");
        mevcut.son_etkinlik = Date.now();
        return jsonYanit(res, 200, {
          kod: mevcut.kod,
          anahtar: mevcut.anahtar,
          qr_jeton: mevcut.qr_jeton,
          surdu: true,
          son: mevcut.sayac,
          ogrenci_modu: mevcut.ogrenci_modu
        });
      }

      let yeniKod = "";
      do {
        yeniKod = String(crypto.randomInt(100000, 999999));
      } while (globalBellek.odalar.has(yeniKod));

      const oda = odaOlusturVeyaGetir(yeniKod, oturum ? oturum.uid : "");
      return jsonYanit(res, 200, {
        kod: oda.kod,
        anahtar: oda.anahtar,
        qr_jeton: oda.qr_jeton,
        surdu: false,
        son: oda.sayac,
        ogrenci_modu: oda.ogrenci_modu
      });
    }

    // --- ODAYA KATIL (/api/katil) ---
    if (yol === "/api/katil") {
      if (!hizIzniVarMi(`katil:${ip}`, 15, 180)) {
        return jsonYanit(res, 429, { hata: "Çok fazla bağlantı denemesi. 3 dakika bekleyin." });
      }
      const kod = String(veri.kod || "").replace(/\s+/g, "");
      if (!/^\d{6}$/.test(kod)) {
        return jsonYanit(res, 400, { hata: "Geçersiz 6 haneli tahta kodu." });
      }
      // Bulut ortamında P2P + Relay birlikte çalıştığı için odayı deterministik hazırla
      const oda = odaOlusturVeyaGetir(kod);
      if (oda.kapandi) {
        return jsonYanit(res, 404, { hata: "Bu tahta oturumu kapatılmış." });
      }

      const eskiCid = String(veri.cihaz || "");
      const eskiAnahtar = String(veri.canahtar || "");
      if (eskiCid && guvenliEsitMi(cihazAnahtariUret(kod, eskiCid), eskiAnahtar)) {
        let c = oda.cihazlar.get(eskiCid);
        if (!c) {
          c = { id: eskiCid, ad: "Telefon", rol: "ogretmen", durum: "onayli", anahtar: eskiAnahtar, son_gorulme: Date.now() };
          oda.cihazlar.set(eskiCid, c);
        } else {
          c.son_gorulme = Date.now();
        }
        return jsonYanit(res, 200, {
          cihaz: c.id,
          canahtar: c.anahtar,
          rol: c.rol,
          durum: c.durum,
          son: oda.sayac
        });
      }

      const qrJeton = String(veri.qr_jeton || "").trim();
      const kullaniciId = oturum ? String(oturum.uid || "") : "";
      const varsayilanAd = oturum ? String(oturum.ad || "") : "";
      const ad = (varsayilanAd || String(veri.ad || "Telefon")).trim().slice(0, 40);
      const ogrenciAd = String(veri.ogrenci_ad || "").trim().slice(0, 40);
      const onayliOgretmenVar = Array.from(oda.cihazlar.values()).some((x) => x.rol === "ogretmen" && x.durum === "onayli");
      const qrDogru = Boolean(qrJeton && guvenliEsitMi(oda.qr_jeton, qrJeton));
      const ayniHesap = Boolean(kullaniciId && oda.sahip_id && kullaniciId === oda.sahip_id);

      let rol = "ogretmen";
      let durum = "onayli";
      let gorunenAd = ad;

      if (!onayliOgretmenVar || qrDogru || ayniHesap) {
        rol = "ogretmen";
        durum = "onayli";
      } else if (oda.ogrenci_modu) {
        if (ogrenciAd.length < 2 && !varsayilanAd) {
          return jsonYanit(res, 400, { hata: "Adını yazmalısın.", ad_gerekli: true });
        }
        rol = "ogrenci";
        durum = "onayli";
        gorunenAd = ogrenciAd || varsayilanAd;
      } else {
        rol = "ogretmen";
        durum = "bekliyor";
        gorunenAd = ogrenciAd || ad;
      }

      const cid = `c${oda.cihazlar.size + 1}_${crypto.randomBytes(4).toString("hex")}`;
      const canahtar = cihazAnahtariUret(kod, cid);
      const yeniCihaz = {
        id: cid,
        ad: gorunenAd,
        rol,
        durum,
        kullanici_id: kullaniciId,
        anahtar: canahtar,
        son_gorulme: Date.now()
      };
      oda.cihazlar.set(cid, yeniCihaz);
      oda.son_etkinlik = Date.now();

      return jsonYanit(res, 200, {
        cihaz: yeniCihaz.id,
        canahtar: yeniCihaz.anahtar,
        rol: yeniCihaz.rol,
        durum: yeniCihaz.durum,
        son: oda.sayac
      });
    }

    // --- TAHTA DURUM (/api/tahta_durum) ---
    if (yol === "/api/tahta_durum") {
      const kod = String(veri.kod || "");
      const anahtar = String(veri.anahtar || "");
      const son = Number(veri.son || 0);
      if (!/^\d{6}$/.test(kod) || !guvenliEsitMi(odaAnahtariUret(kod), anahtar)) {
        return jsonYanit(res, 403, { hata: "Yetkisiz tahta erişimi" });
      }
      const oda = odaOlusturVeyaGetir(kod);
      oda.son_etkinlik = Date.now();
      const cihazListesi = Array.from(oda.cihazlar.values())
        .filter((c) => c.durum === "onayli" || c.durum === "bekliyor")
        .map((c) => ({
          id: c.id,
          ad: c.ad,
          rol: c.rol,
          durum: c.durum,
          bagli: Date.now() - c.son_gorulme < 15000
        }));
      const yeniMesajlar = oda.mesajlar.filter((m) => m.id > son && (m.kime === "tahta" || m.kime === "hepsi"));
      return jsonYanit(res, 200, {
        ogrenci_modu: oda.ogrenci_modu,
        cihazlar: cihazListesi,
        mesajlar: yeniMesajlar,
        son: oda.sayac
      });
    }

    // --- TELEFON DURUM (/api/tel_durum) ---
    if (yol === "/api/tel_durum") {
      const kod = String(veri.kod || "");
      const cid = String(veri.cihaz || "");
      const canahtar = String(veri.canahtar || "");
      const son = Number(veri.son || 0);
      if (!/^\d{6}$/.test(kod) || !guvenliEsitMi(cihazAnahtariUret(kod, cid), canahtar)) {
        return jsonYanit(res, 403, { hata: "Yetkisiz cihaz erişimi" });
      }
      const oda = odaOlusturVeyaGetir(kod);
      let c = oda.cihazlar.get(cid);
      if (!c) {
        c = { id: cid, ad: "Telefon", rol: "ogretmen", durum: "onayli", anahtar: canahtar, son_gorulme: Date.now() };
        oda.cihazlar.set(cid, c);
      } else {
        c.son_gorulme = Date.now();
      }
      const yeniMesajlar = oda.mesajlar.filter(
        (m) => m.id > son && c.durum === "onayli" && (m.kime === cid || m.kime === "hepsi" || (m.kime === "ogretmenler" && c.rol === "ogretmen"))
      );
      return jsonYanit(res, 200, {
        durum: c.durum,
        rol: c.rol,
        mesajlar: yeniMesajlar,
        son: oda.sayac
      });
    }

    // --- CİHAZ ONAY/RED (/api/cihaz_karar) ---
    if (yol === "/api/cihaz_karar") {
      const kod = String(veri.kod || "");
      const anahtar = String(veri.anahtar || "");
      const cid = String(veri.cihaz || "");
      const karar = String(veri.karar || "");
      const rol = String(veri.rol || "ogretmen");
      const oda = globalBellek.odalar.get(kod);
      if (!oda || !guvenliEsitMi(oda.anahtar, anahtar)) {
        return jsonYanit(res, 403, { hata: "Yetkisiz işlem" });
      }
      const c = oda.cihazlar.get(cid);
      if (c) {
        if (karar === "onay") {
          c.durum = "onayli";
          c.rol = rol === "ogrenci" ? "ogrenci" : "ogretmen";
        } else {
          c.durum = "red";
        }
      }
      const cihazListesi = Array.from(oda.cihazlar.values())
        .filter((x) => x.durum === "onayli" || x.durum === "bekliyor")
        .map((x) => ({
          id: x.id,
          ad: x.ad,
          rol: x.rol,
          durum: x.durum,
          bagli: Date.now() - x.son_gorulme < 15000
        }));
      return jsonYanit(res, 200, { cihazlar: cihazListesi });
    }

    // --- ODA AYAR (/api/oda_ayar) ---
    if (yol === "/api/oda_ayar") {
      const kod = String(veri.kod || "");
      const anahtar = String(veri.anahtar || "");
      const oda = odaOlusturVeyaGetir(kod);
      if (!guvenliEsitMi(oda.anahtar, anahtar)) {
        return jsonYanit(res, 403, { hata: "Yetkisiz işlem" });
      }
      oda.ogrenci_modu = Boolean(veri.ogrenci_modu);
      return jsonYanit(res, 200, { ogrenci_modu: oda.ogrenci_modu });
    }

    // --- MESAJ GÖNDER (/api/mesaj) ---
    if (yol === "/api/mesaj") {
      const kod = String(veri.kod || "");
      const kimden = String(veri.kimden || "");
      const anahtar = String(veri.anahtar || "");
      const oda = odaOlusturVeyaGetir(kod);
      if (!gondericiYetkiliMi(oda, kimden, anahtar)) {
        return jsonYanit(res, 403, { hata: "Mesaj gönderme yetkiniz yok." });
      }
      const kime = String(veri.kime || "tahta");
      const tur = String(veri.tur || "");
      const icerik = veri.veri && typeof veri.veri === "object" ? veri.veri : {};
      const mid = odaMesajEkle(oda, kimden, kime, tur, icerik);
      return jsonYanit(res, 200, { id: mid });
    }

    // --- ODA KAPAT (/api/oda_kapat) ---
    if (yol === "/api/oda_kapat") {
      const kod = String(veri.kod || "");
      const anahtar = String(veri.anahtar || "");
      const oda = globalBellek.odalar.get(kod);
      if (oda && guvenliEsitMi(oda.anahtar, anahtar)) {
        oda.kapandi = true;
        globalBellek.odalar.delete(kod);
      }
      return jsonYanit(res, 200, { kapandi: true });
    }

    return jsonYanit(res, 404, { hata: "Bilinmeyen API uç noktası" });
  }

  return jsonYanit(res, 405, { hata: "İzin verilmeyen HTTP metodu" });
};
