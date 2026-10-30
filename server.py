from __future__ import annotations

import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import socket
import threading
import time
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

KOK_DIZIN: Path = Path(__file__).resolve().parent
VERI_DIZIN: Path = KOK_DIZIN / "veri"
KULLANICI_DOSYA: Path = VERI_DIZIN / "kullanicilar.json"
PORT: int = int(os.environ.get("TAHTA_PORT", "8080"))
ODA_OMRU_SN: float = 6 * 3600.0          # 6 saat
OTURUM_OMRU_SN: float = 30 * 86400.0     # 30 gün
MAKS_DOSYA_BOYUT: int = 50 * 1024 * 1024  # 50 MB
MAKS_ODA_BELLEK: int = 150 * 1024 * 1024  # 150 MB / oda
MAKS_ODA_SAYISI: int = 200
PBKDF2_ITERASYON: int = 120_000

# Sunucu imzalama anahtarı (oturum token'ları için)
GIZLI_IMZA_ANAHTARI: bytes = os.environ.get(
    "TAHTA_GIZLI_ANAHTAR", secrets.token_hex(32)
).encode("utf-8")

mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("application/manifest+json", ".webmanifest")

# Tarayıcıda doğrudan çalıştırılması tehlikeli olabilecek MIME türleri (XSS koruması)
INDIRME_ZORUNLU_TURLER: set[str] = {
    "text/html",
    "application/xhtml+xml",
    "image/svg+xml",
    "application/javascript",
    "text/javascript",
    "application/x-javascript",
}


class HizSinirlayici:
    """IP bazlı brute-force ve DoS koruma katmanı."""

    def __init__(self) -> None:
        self.kayitlar: dict[str, list[float]] = {}
        self.kilit: threading.Lock = threading.Lock()

    def izin_var_mi(self, anahtar: str, limit: int, pencere_sn: float) -> bool:
        simdi = time.time()
        with self.kilit:
            gecmis = self.kayitlar.get(anahtar, [])
            gecmis = [z for z in gecmis if simdi - z < pencere_sn]
            if len(gecmis) >= limit:
                self.kayitlar[anahtar] = gecmis
                return False
            gecmis.append(simdi)
            self.kayitlar[anahtar] = gecmis
            return True


HIZ_SINIRI: HizSinirlayici = HizSinirlayici()
KILIT: threading.Lock = threading.Lock()


def sifre_ozetle(sifre: str, tuz_hex: str | None = None) -> tuple[str, str]:
    tuz = bytes.fromhex(tuz_hex) if tuz_hex else secrets.token_bytes(16)
    ozet = hashlib.pbkdf2_hmac("sha256", sifre.encode("utf-8"), tuz, PBKDF2_ITERASYON)
    return tuz.hex(), ozet.hex()


def sifre_dogrula(sifre: str, tuz_hex: str, beklenen_ozet_hex: str) -> bool:
    try:
        _, hesaplanan = sifre_ozetle(sifre, tuz_hex)
        return hmac.compare_digest(hesaplanan, beklenen_ozet_hex)
    except Exception:
        return False


def oturum_token_uret(kullanici: dict[str, Any]) -> str:
    veri = {
        "uid": kullanici["id"],
        "kadi": kullanici["kullanici_adi"],
        "ad": kullanici["ad_soyad"],
        "kurum": kullanici.get("kurum", ""),
        "son": int(time.time() + OTURUM_OMRU_SN),
    }
    govde = json.dumps(veri, ensure_ascii=False, separators=(",", ":")).encode("utf-8").hex()
    imza = hmac.new(GIZLI_IMZA_ANAHTARI, govde.encode("ascii"), hashlib.sha256).hexdigest()
    return f"{govde}.{imza}"


def oturum_token_coz(token: str) -> dict[str, Any] | None:
    if not token or "." not in token:
        return None
    try:
        govde, imza = token.split(".", 1)
        beklenen = hmac.new(GIZLI_IMZA_ANAHTARI, govde.encode("ascii"), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(imza, beklenen):
            return None
        veri = json.loads(bytes.fromhex(govde).decode("utf-8"))
        if not isinstance(veri, dict) or int(veri.get("son", 0)) < int(time.time()):
            return None
        return veri
    except Exception:
        return None


def kullanicilari_yukle() -> dict[str, dict[str, Any]]:
    try:
        if KULLANICI_DOSYA.is_file():
            veri = json.loads(KULLANICI_DOSYA.read_text(encoding="utf-8"))
            if isinstance(veri, dict):
                return veri
    except Exception:
        pass
    return {}


def kullanicilari_kaydet(kullanicilar: dict[str, dict[str, Any]]) -> None:
    VERI_DIZIN.mkdir(parents=True, exist_ok=True)
    gecici = KULLANICI_DOSYA.with_suffix(".tmp")
    gecici.write_text(json.dumps(kullanicilar, ensure_ascii=False, indent=2), encoding="utf-8")
    gecici.replace(KULLANICI_DOSYA)


class CihazKaydi:
    def __init__(self, cid: str, ad: str, rol: str, durum: str, kullanici_id: str = "") -> None:
        self.id: str = cid
        self.ad: str = ad
        self.rol: str = rol          # "ogretmen" | "ogrenci"
        self.durum: str = durum      # "onayli" | "bekliyor" | "red"
        self.kullanici_id: str = kullanici_id
        self.anahtar: str = secrets.token_hex(16)
        self.son_gorulme: float = time.time()


class DosyaKaydi:
    def __init__(self, did: str, yerel: str, ad: str, tur: str, boyut: int, gonderen_id: str, hedef: str) -> None:
        self.id: str = did
        self.yerel: str = yerel
        self.ad: str = re.sub(r"[\x00-\x1f\\/:*?\"<>|]", "_", ad)[:180] or "dosya"
        self.tur: str = tur
        self.boyut: int = boyut
        self.gonderen_id: str = gonderen_id
        self.hedef: str = hedef      # "tahta" veya cihaz id
        self.veri: bytearray = bytearray()
        self.tamam: bool = False
        self.zaman: float = time.time()


class OdaKaydi:
    def __init__(self, kod: str, sahip_id: str = "") -> None:
        self.kod: str = kod
        self.sahip_id: str = sahip_id
        self.anahtar: str = secrets.token_hex(20)
        self.qr_jeton: str = secrets.token_hex(12)
        self.olusturma: float = time.time()
        self.son_etkinlik: float = time.time()
        self.ogrenci_modu: bool = False
        self.kapandi: bool = False
        self.toplam_bellek: int = 0
        self.cihazlar: dict[str, CihazKaydi] = {}
        self.mesajlar: list[dict[str, Any]] = []
        self.dosyalar: dict[str, DosyaKaydi] = {}
        self.sayac: int = 0

    def mesaj_ekle(self, kimden: str, kime: str, tur: str, veri: dict[str, Any]) -> int:
        self.sayac += 1
        self.son_etkinlik = time.time()
        m: dict[str, Any] = {
            "id": self.sayac,
            "kimden": kimden,
            "kime": kime,
            "tur": str(tur)[:48],
            "veri": veri,
            "zaman": time.time(),
        }
        self.mesajlar.append(m)
        if len(self.mesajlar) > 500:
            self.mesajlar = self.mesajlar[-350:]
        return self.sayac

    def gonderici_yetkili_mi(self, kimden: str, anahtar: str) -> bool:
        if not anahtar:
            return False
        if kimden == "tahta" and hmac.compare_digest(self.anahtar, anahtar):
            return True
        c = self.cihazlar.get(kimden)
        if c and c.durum == "onayli" and hmac.compare_digest(c.anahtar, anahtar):
            return True
        return False


ODALAR: dict[str, OdaKaydi] = {}


def yerel_ipleri_bul() -> list[str]:
    ipler: list[str] = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.2)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        if ip and not ip.startswith("127."):
            ipler.append(ip)
    except Exception:
        pass

    try:
        for bilgi in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip_aday = str(bilgi[4][0])
            if ip_aday and not ip_aday.startswith("127.") and not ip_aday.startswith("169.254.") and ip_aday not in ipler:
                ipler.append(ip_aday)
    except Exception:
        pass

    def oncelik(ip_str: str) -> int:
        if ip_str.startswith("192.168."):
            return 0
        if ip_str.startswith("10."):
            return 1
        if ip_str.startswith("172."):
            return 2
        return 3

    ipler.sort(key=oncelik)
    return ipler


def eski_odalari_temizle() -> None:
    simdi = time.time()
    silinecek = [k for k, o in ODALAR.items() if simdi - o.son_etkinlik > ODA_OMRU_SN or o.kapandi]
    for k in silinecek:
        del ODALAR[k]


def yeni_kod_uret() -> str:
    while True:
        kod = f"{secrets.randbelow(900000) + 100000}"
        if kod not in ODALAR:
            return kod


class TahtaIstekIsleyici(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: Any) -> None:
        pass

    def _istemci_ip(self) -> str:
        ileri = self.headers.get("X-Forwarded-For", "")
        if ileri:
            return ileri.split(",")[0].strip()
        return self.client_address[0] if self.client_address else "0.0.0.0"

    def _guvenlik_basliklari_ekle(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header(
            "Permissions-Policy",
            "camera=(self), microphone=(), display-capture=(self), fullscreen=(self)",
        )
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; "
            "script-src 'self'; "
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
            "font-src 'self' https://fonts.gstatic.com; "
            "img-src 'self' data: blob:; "
            "media-src 'self' data: blob:; "
            "connect-src 'self' https://*.peerjs.com wss://*.peerjs.com; "
            "frame-src https://www.youtube.com https://www.instagram.com https: http:; "
            "object-src 'none'; "
            "base-uri 'self';",
        )

    def _oturum_kullanici_bul(self) -> dict[str, Any] | None:
        yetki = self.headers.get("X-Oturum-Token", "").strip()
        if not yetki:
            cerez_ham = self.headers.get("Cookie", "")
            if cerez_ham:
                c = SimpleCookie()
                try:
                    c.load(cerez_ham)
                    if "tahta_oturum" in c:
                        yetki = c["tahta_oturum"].value
                except Exception:
                    pass
        return oturum_token_coz(yetki)

    def _json_yanit(self, durum: int, veri: dict[str, Any], ek_basliklar: list[tuple[str, str]] | None = None) -> None:
        govde = json.dumps(veri, ensure_ascii=False).encode("utf-8")
        self.send_response(durum)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(govde)))
        self.send_header("Cache-Control", "no-store")
        self._guvenlik_basliklari_ekle()
        if ek_basliklar:
            for k, v in ek_basliklar:
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(govde)

    def _json_oku(self, maks_boyut: int = 256 * 1024) -> dict[str, Any]:
        uzunluk = int(self.headers.get("Content-Length", "0") or 0)
        if uzunluk <= 0 or uzunluk > maks_boyut:
            return {}
        ham = self.rfile.read(uzunluk)
        try:
            sonuc = json.loads(ham.decode("utf-8"))
            return sonuc if isinstance(sonuc, dict) else {}
        except Exception:
            return {}

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Oturum-Token, X-Gonderen-Anahtar")
        self._guvenlik_basliklari_ekle()
        self.end_headers()

    def do_GET(self) -> None:
        ayristirma = urlparse(self.path)
        yol = ayristirma.path
        sorgu = parse_qs(ayristirma.query)

        if yol == "/api/bilgi":
            ipler = yerel_ipleri_bul()
            ana_ip = ipler[0] if ipler else "127.0.0.1"
            oturum = self._oturum_kullanici_bul()
            self._json_yanit(200, {
                "sunucu": "tahta-at-yerel",
                "port": PORT,
                "ip": ana_ip,
                "ipler": ipler,
                "adres": f"http://{ana_ip}:{PORT}",
                "kullanici": oturum,
            })
            return

        if yol == "/api/oturum":
            oturum = self._oturum_kullanici_bul()
            self._json_yanit(200, {"kullanici": oturum})
            return

        if yol == "/api/dosya_indir":
            kod = (sorgu.get("kod") or [""])[0]
            did = (sorgu.get("id") or [""])[0]
            anahtar = (sorgu.get("anahtar") or [""])[0] or self.headers.get("X-Gonderen-Anahtar", "")
            with KILIT:
                oda = ODALAR.get(kod)
                if not oda or oda.kapandi:
                    self._json_yanit(404, {"hata": "Oda bulunamadı"})
                    return
                # Yetki kontrolü: tahta anahtarı veya onaylı cihaz anahtarı
                yetkili = hmac.compare_digest(oda.anahtar, anahtar) or any(
                    c.durum == "onayli" and hmac.compare_digest(c.anahtar, anahtar)
                    for c in oda.cihazlar.values()
                )
                if not yetkili:
                    self._json_yanit(403, {"hata": "Bu dosyayı indirme yetkiniz yok"})
                    return
                dosya = oda.dosyalar.get(did)
                if not dosya or not dosya.tamam:
                    self._json_yanit(404, {"hata": "Dosya bulunamadı"})
                    return
                veri = bytes(dosya.veri)
                tur = (dosya.tur or "application/octet-stream").split(";")[0].strip().lower()
                ad = dosya.ad

            guvenli_tur = "application/octet-stream" if tur in INDIRME_ZORUNLU_TURLER else tur
            self.send_response(200)
            self.send_header("Content-Type", guvenli_tur)
            self.send_header("Content-Length", str(len(veri)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Disposition", f'attachment; filename="{ad}"')
            self._guvenlik_basliklari_ekle()
            self.end_headers()
            self.wfile.write(veri)
            return

        if yol in ("/", "/index.html", "/tahta", "/gonder", "/giris", "/kayit") or yol.startswith("/g/"):
            dosya_yolu = KOK_DIZIN / "index.html"
            self._statik_dosya_gonder(dosya_yolu)
            return

        # Statik varlıklar: yalnızca izin verilen klasörlerden (`assets/`) sun, `server.py` veya `veri/` asla dışarı sızmasın
        temiz_yol = yol.lstrip("/")
        if not temiz_yol.startswith("assets/"):
            self._json_yanit(404, {"hata": "Sayfa bulunamadı"})
            return
        aday = (KOK_DIZIN / temiz_yol).resolve()
        assets_kok = (KOK_DIZIN / "assets").resolve()
        if not str(aday).startswith(str(assets_kok)) or not aday.is_file():
            self._json_yanit(404, {"hata": "Dosya bulunamadı"})
            return
        self._statik_dosya_gonder(aday)

    def _statik_dosya_gonder(self, dosya_yolu: Path) -> None:
        try:
            icerik = dosya_yolu.read_bytes()
        except Exception:
            self._json_yanit(404, {"hata": "Dosya okunamadı"})
            return
        tur, _ = mimetypes.guess_type(str(dosya_yolu))
        self.send_response(200)
        self.send_header("Content-Type", tur or "application/octet-stream")
        self.send_header("Content-Length", str(len(icerik)))
        self.send_header("Cache-Control", "no-cache")
        self._guvenlik_basliklari_ekle()
        self.end_headers()
        self.wfile.write(icerik)

    def do_POST(self) -> None:
        ayristirma = urlparse(self.path)
        yol = ayristirma.path
        sorgu = parse_qs(ayristirma.query)
        ip = self._istemci_ip()

        if yol == "/api/dosya_yukle":
            if not HIZ_SINIRI.izin_var_mi(f"yukle:{ip}", 180, 60.0):
                self._json_yanit(429, {"hata": "Çok fazla yükleme isteği. Lütfen biraz bekleyin."})
                return
            self._dosya_yukle_isle(sorgu)
            return

        veri = self._json_oku()

        # --- KULLANICI KAYIT (/api/kayit) ---
        if yol == "/api/kayit":
            if not HIZ_SINIRI.izin_var_mi(f"kayit:{ip}", 8, 300.0):
                self._json_yanit(429, {"hata": "Çok fazla kayıt denemesi. 5 dakika sonra tekrar deneyin."})
                return
            ad_soyad = str(veri.get("ad_soyad") or "").strip()[:60]
            kadi_ham = str(veri.get("kullanici_adi") or "").strip().lower()[:60]
            kurum = str(veri.get("kurum") or "").strip()[:80]
            sifre = str(veri.get("sifre") or "")

            if len(ad_soyad) < 2:
                self._json_yanit(400, {"hata": "Ad ve soyad en az 2 karakter olmalıdır."})
                return
            if not re.match(r"^[a-z0-9._@-]{3,60}$", kadi_ham):
                self._json_yanit(400, {"hata": "Kullanıcı adı veya e-posta geçersiz (en az 3 karakter, harf/rakam)."})
                return
            if len(sifre) < 8 or len(sifre) > 128:
                self._json_yanit(400, {"hata": "Şifre en az 8 karakter olmalıdır."})
                return

            with KILIT:
                kullanicilar = kullanicilari_yukle()
                if kadi_ham in kullanicilar:
                    self._json_yanit(409, {"hata": "Bu kullanıcı adı veya e-posta zaten kayıtlı."})
                    return
                tuz_hex, ozet_hex = sifre_ozetle(sifre)
                yeni_k = {
                    "id": f"u_{secrets.token_hex(8)}",
                    "kullanici_adi": kadi_ham,
                    "ad_soyad": ad_soyad,
                    "kurum": kurum,
                    "tuz": tuz_hex,
                    "ozet": ozet_hex,
                    "olusturma": int(time.time()),
                }
                kullanicilar[kadi_ham] = yeni_k
                kullanicilari_kaydet(kullanicilar)

            token = oturum_token_uret(yeni_k)
            cerez = f"tahta_oturum={token}; Path=/; Max-Age={int(OTURUM_OMRU_SN)}; HttpOnly; SameSite=Strict"
            self._json_yanit(200, {
                "kullanici": {
                    "id": yeni_k["id"],
                    "kadi": yeni_k["kullanici_adi"],
                    "ad": yeni_k["ad_soyad"],
                    "kurum": yeni_k["kurum"],
                },
                "token": token,
            }, [("Set-Cookie", cerez)])
            return

        # --- KULLANICI GİRİŞ (/api/giris) ---
        if yol == "/api/giris":
            if not HIZ_SINIRI.izin_var_mi(f"giris:{ip}", 10, 300.0):
                self._json_yanit(429, {"hata": "Çok fazla başarısız giriş denemesi. 5 dakika bekleyin."})
                return
            kadi_ham = str(veri.get("kullanici_adi") or "").strip().lower()[:60]
            sifre = str(veri.get("sifre") or "")

            with KILIT:
                kullanicilar = kullanicilari_yukle()
                kayit = kullanicilar.get(kadi_ham)

            if not kayit or not sifre_dogrula(sifre, kayit.get("tuz", ""), kayit.get("ozet", "")):
                self._json_yanit(401, {"hata": "Kullanıcı adı/e-posta veya şifre hatalı."})
                return

            token = oturum_token_uret(kayit)
            cerez = f"tahta_oturum={token}; Path=/; Max-Age={int(OTURUM_OMRU_SN)}; HttpOnly; SameSite=Strict"
            self._json_yanit(200, {
                "kullanici": {
                    "id": kayit["id"],
                    "kadi": kayit["kullanici_adi"],
                    "ad": kayit["ad_soyad"],
                    "kurum": kayit.get("kurum", ""),
                },
                "token": token,
            }, [("Set-Cookie", cerez)])
            return

        # --- ÇIKIŞ (/api/cikis) ---
        if yol == "/api/cikis":
            cerez = "tahta_oturum=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict"
            self._json_yanit(200, {"cikis": True}, [("Set-Cookie", cerez)])
            return

        oturum = self._oturum_kullanici_bul()

        with KILIT:
            eski_odalari_temizle()

            if yol == "/api/oda_ac":
                if not HIZ_SINIRI.izin_var_mi(f"oda_ac:{ip}", 25, 60.0):
                    self._json_yanit(429, {"hata": "Çok fazla oda açma isteği."})
                    return
                istenen_kod = str(veri.get("kod") or "").strip()
                istenen_anahtar = str(veri.get("anahtar") or "").strip()
                if istenen_kod and istenen_kod in ODALAR:
                    mevcut = ODALAR[istenen_kod]
                    if hmac.compare_digest(mevcut.anahtar, istenen_anahtar) and not mevcut.kapandi:
                        mevcut.son_etkinlik = time.time()
                        self._json_yanit(200, {
                            "kod": mevcut.kod,
                            "anahtar": mevcut.anahtar,
                            "qr_jeton": mevcut.qr_jeton,
                            "surdu": True,
                            "son": mevcut.sayac,
                            "ogrenci_modu": mevcut.ogrenci_modu,
                        })
                        return
                if len(ODALAR) >= MAKS_ODA_SAYISI:
                    self._json_yanit(503, {"hata": "Sunucu oda kapasitesi dolu."})
                    return
                yeni_kod = yeni_kod_uret()
                sahip_id = str(oturum.get("uid") or "") if oturum else ""
                oda = OdaKaydi(yeni_kod, sahip_id)
                ODALAR[yeni_kod] = oda
                self._json_yanit(200, {
                    "kod": oda.kod,
                    "anahtar": oda.anahtar,
                    "qr_jeton": oda.qr_jeton,
                    "surdu": False,
                    "son": oda.sayac,
                    "ogrenci_modu": oda.ogrenci_modu,
                })
                return

            if yol == "/api/katil":
                if not HIZ_SINIRI.izin_var_mi(f"katil:{ip}", 15, 180.0):
                    self._json_yanit(429, {"hata": "Çok fazla bağlantı denemesi. 3 dakika bekleyin."})
                    return
                kod = str(veri.get("kod") or "").replace(" ", "").strip()
                qr_jeton = str(veri.get("qr_jeton") or "").strip()
                oda = ODALAR.get(kod)
                if not oda or oda.kapandi:
                    self._json_yanit(404, {"hata": "Bu kodla açık bir tahta bulunamadı. Tahtadaki 6 haneli kodu kontrol et."})
                    return

                eski_cid = str(veri.get("cihaz") or "")
                eski_anahtar = str(veri.get("canahtar") or "")
                if eski_cid and eski_cid in oda.cihazlar and hmac.compare_digest(oda.cihazlar[eski_cid].anahtar, eski_anahtar):
                    c = oda.cihazlar[eski_cid]
                    c.son_gorulme = time.time()
                    self._json_yanit(200, {
                        "cihaz": c.id,
                        "canahtar": c.anahtar,
                        "rol": c.rol,
                        "durum": c.durum,
                        "son": oda.sayac,
                    })
                    return

                kullanici_id = str(oturum.get("uid") or "") if oturum else ""
                varsayilan_ad = str(oturum.get("ad") or "") if oturum else ""
                ad = (varsayilan_ad or str(veri.get("ad") or "Telefon")).strip()[:40]
                ogrenci_ad = str(veri.get("ogrenci_ad") or "").strip()[:40]
                onayli_ogretmenler = [x for x in oda.cihazlar.values() if x.rol == "ogretmen" and x.durum == "onayli"]

                # Aynı hesapla açılmış tahta veya QR jetonu eşleşmesi veya ilk öğretmen cihazı
                qr_dogru = bool(qr_jeton and hmac.compare_digest(oda.qr_jeton, qr_jeton))
                ayni_hesap = bool(kullanici_id and oda.sahip_id and kullanici_id == oda.sahip_id)

                if not onayli_ogretmenler or ayni_hesap or qr_dogru:
                    rol = "ogretmen"
                    durum = "onayli"
                    gorunen_ad = ad
                elif oda.ogrenci_modu:
                    if len(ogrenci_ad) < 2 and not varsayilan_ad:
                        self._json_yanit(400, {"hata": "Adını yazmalısın.", "ad_gerekli": True})
                        return
                    rol = "ogrenci"
                    durum = "onayli"
                    gorunen_ad = ogrenci_ad or varsayilan_ad
                else:
                    rol = "ogretmen"
                    durum = "bekliyor"
                    gorunen_ad = ogrenci_ad or ad

                cid = f"c{len(oda.cihazlar) + 1}_{secrets.token_hex(4)}"
                yeni_cihaz = CihazKaydi(cid, gorunen_ad, rol, durum, kullanici_id)
                oda.cihazlar[cid] = yeni_cihaz
                oda.son_etkinlik = time.time()
                self._json_yanit(200, {
                    "cihaz": yeni_cihaz.id,
                    "canahtar": yeni_cihaz.anahtar,
                    "rol": yeni_cihaz.rol,
                    "durum": yeni_cihaz.durum,
                    "son": oda.sayac,
                })
                return

            if yol == "/api/tahta_durum":
                kod = str(veri.get("kod") or "")
                anahtar = str(veri.get("anahtar") or "")
                son = int(veri.get("son") or 0)
                oda = ODALAR.get(kod)
                if not oda or not hmac.compare_digest(oda.anahtar, anahtar) or oda.kapandi:
                    self._json_yanit(404, {"hata": "Oda kapandı"})
                    return
                oda.son_etkinlik = time.time()
                simdi = time.time()
                cihaz_listesi = [
                    {
                        "id": c.id,
                        "ad": c.ad,
                        "rol": c.rol,
                        "durum": c.durum,
                        "bagli": (simdi - c.son_gorulme) < 12.0,
                    }
                    for c in oda.cihazlar.values()
                    if c.durum in ("onayli", "bekliyor")
                ]
                yeni_mesajlar = [
                    m for m in oda.mesajlar
                    if m["id"] > son and m["kime"] in ("tahta", "hepsi")
                ]
                self._json_yanit(200, {
                    "ogrenci_modu": oda.ogrenci_modu,
                    "cihazlar": cihaz_listesi,
                    "mesajlar": yeni_mesajlar,
                    "son": oda.sayac,
                })
                return

            if yol == "/api/tel_durum":
                kod = str(veri.get("kod") or "")
                cid = str(veri.get("cihaz") or "")
                canahtar = str(veri.get("canahtar") or "")
                son = int(veri.get("son") or 0)
                oda = ODALAR.get(kod)
                if not oda or oda.kapandi:
                    self._json_yanit(200, {"durum": "kapandi", "mesajlar": []})
                    return
                c = oda.cihazlar.get(cid)
                if not c or not hmac.compare_digest(c.anahtar, canahtar):
                    self._json_yanit(404, {"hata": "Cihaz kaydı bulunamadı"})
                    return
                c.son_gorulme = time.time()
                yeni_mesajlar = [
                    m for m in oda.mesajlar
                    if m["id"] > son and c.durum == "onayli" and (
                        m["kime"] == cid or m["kime"] == "hepsi" or (m["kime"] == "ogretmenler" and c.rol == "ogretmen")
                    )
                ]
                self._json_yanit(200, {
                    "durum": c.durum,
                    "rol": c.rol,
                    "mesajlar": yeni_mesajlar,
                    "son": oda.sayac,
                })
                return

            if yol == "/api/cihaz_karar":
                kod = str(veri.get("kod") or "")
                anahtar = str(veri.get("anahtar") or "")
                cid = str(veri.get("cihaz") or "")
                karar = str(veri.get("karar") or "")
                rol = str(veri.get("rol") or "ogretmen")
                oda = ODALAR.get(kod)
                if not oda or not hmac.compare_digest(oda.anahtar, anahtar):
                    self._json_yanit(404, {"hata": "Oda bulunamadı"})
                    return
                c = oda.cihazlar.get(cid)
                if c:
                    if karar == "onay":
                        c.durum = "onayli"
                        c.rol = rol if rol in ("ogretmen", "ogrenci") else "ogretmen"
                    else:
                        c.durum = "red"
                simdi = time.time()
                cihaz_listesi = [
                    {
                        "id": x.id,
                        "ad": x.ad,
                        "rol": x.rol,
                        "durum": x.durum,
                        "bagli": (simdi - x.son_gorulme) < 12.0,
                    }
                    for x in oda.cihazlar.values()
                    if x.durum in ("onayli", "bekliyor")
                ]
                self._json_yanit(200, {"cihazlar": cihaz_listesi})
                return

            if yol == "/api/oda_ayar":
                kod = str(veri.get("kod") or "")
                anahtar = str(veri.get("anahtar") or "")
                oda = ODALAR.get(kod)
                if not oda or not hmac.compare_digest(oda.anahtar, anahtar):
                    self._json_yanit(404, {"hata": "Oda bulunamadı"})
                    return
                oda.ogrenci_modu = bool(veri.get("ogrenci_modu"))
                self._json_yanit(200, {"ogrenci_modu": oda.ogrenci_modu})
                return

            if yol == "/api/mesaj":
                kod = str(veri.get("kod") or "")
                oda = ODALAR.get(kod)
                if not oda or oda.kapandi:
                    self._json_yanit(404, {"hata": "Oda bulunamadı"})
                    return
                kimden = str(veri.get("kimden") or "")
                gonderen_anahtar = str(veri.get("anahtar") or "")
                if not oda.gonderici_yetkili_mi(kimden, gonderen_anahtar):
                    self._json_yanit(403, {"hata": "Mesaj gönderme yetkiniz yok veya onay bekleniyor."})
                    return
                kime = str(veri.get("kime") or "tahta")
                tur = str(veri.get("tur") or "")
                icerik = veri.get("veri") if isinstance(veri.get("veri"), dict) else {}
                mid = oda.mesaj_ekle(kimden, kime, tur, icerik)
                self._json_yanit(200, {"id": mid})
                return

            if yol == "/api/oda_kapat":
                kod = str(veri.get("kod") or "")
                anahtar = str(veri.get("anahtar") or "")
                oda = ODALAR.get(kod)
                if oda and hmac.compare_digest(oda.anahtar, anahtar):
                    oda.kapandi = True
                    oda.dosyalar.clear()
                self._json_yanit(200, {"kapandi": True})
                return

        self._json_yanit(404, {"hata": "Bilinmeyen API uç noktası"})

    def _dosya_yukle_isle(self, sorgu: dict[str, list[str]]) -> None:
        kod = (sorgu.get("kod") or [""])[0]
        did = (sorgu.get("id") or [""])[0] or f"d_{secrets.token_hex(6)}"
        yerel = (sorgu.get("yerel") or [""])[0]
        ad = (sorgu.get("ad") or ["dosya"])[0]
        tur = (sorgu.get("tur") or ["application/octet-stream"])[0]
        boyut = int((sorgu.get("boyut") or ["0"])[0] or 0)
        kimden = (sorgu.get("kimden") or [""])[0]
        anahtar = (sorgu.get("anahtar") or [""])[0] or self.headers.get("X-Gonderen-Anahtar", "")
        hedef = (sorgu.get("hedef") or ["tahta"])[0]
        son_parca = (sorgu.get("son") or ["1"])[0] == "1"

        uzunluk = int(self.headers.get("Content-Length", "0") or 0)
        if uzunluk < 0 or uzunluk > 10 * 1024 * 1024 or boyut > MAKS_DOSYA_BOYUT:
            self._json_yanit(413, {"hata": "Dosya boyutu izin verilen sınırı (50 MB) aşıyor."})
            return

        parca = self.rfile.read(uzunluk) if uzunluk > 0 else b""

        with KILIT:
            oda = ODALAR.get(kod)
            if not oda or oda.kapandi:
                self._json_yanit(404, {"hata": "Oda bulunamadı"})
                return
            if not oda.gonderici_yetkili_mi(kimden, anahtar):
                self._json_yanit(403, {"hata": "Dosya yükleme yetkiniz yok veya tahta onayı bekleniyor."})
                return
            if oda.toplam_bellek + len(parca) > MAKS_ODA_BELLEK:
                self._json_yanit(413, {"hata": "Oda dosya belleği sınırına ulaşıldı."})
                return

            kayit = oda.dosyalar.get(did)
            if not kayit:
                kayit = DosyaKaydi(did, yerel, ad, tur, boyut, kimden, hedef)
                oda.dosyalar[did] = kayit
            if len(kayit.veri) + len(parca) > MAKS_DOSYA_BOYUT:
                self._json_yanit(413, {"hata": "Dosya boyutu sınırı aşıldı."})
                return

            kayit.veri.extend(parca)
            oda.toplam_bellek += len(parca)
            if son_parca:
                kayit.tamam = True
                kayit.boyut = len(kayit.veri)
                oda.mesaj_ekle(kimden, hedef, "dosya-hazir", {
                    "id": kayit.id,
                    "yerel": kayit.yerel,
                    "ad": kayit.ad,
                    "tur": kayit.tur,
                    "boyut": kayit.boyut,
                    "kimden": kimden,
                })
            alindi = len(kayit.veri)

        self._json_yanit(200, {"id": did, "alindi": alindi, "tamam": son_parca})


def sunucuyu_baslat() -> None:
    ipler = yerel_ipleri_bul()
    ana_ip = ipler[0] if ipler else "127.0.0.1"
    sunucu = ThreadingHTTPServer(("0.0.0.0", PORT), TahtaIstekIsleyici)
    print("=" * 62)
    print("  TAHTAYA AT — Akıllı Tahta & Telefon Köprüsü Çalışıyor")
    print("=" * 62)
    print(f"  Tahta Ekranı (Bu Cihazda) : http://localhost:{PORT}/?ekran=tahta")
    print(f"  Telefon / Ağ Bağlantısı   : http://{ana_ip}:{PORT}")
    if len(ipler) > 1:
        print(f"  Diğer Ağ Arayüzleri       : {', '.join(f'http://{x}:{PORT}' for x in ipler[1:])}")
    print("=" * 62)
    try:
        sunucu.serve_forever()
    except KeyboardInterrupt:
        print("\nSunucu kapatıldı.")
        sunucu.server_close()


if __name__ == "__main__":
    sunucuyu_baslat()
