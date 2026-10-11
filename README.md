# Billingua

İngilizce bir EPUB kitabı, paragraf paragraf eşleşen iki dilli bir EPUB'a çevirir: solda orijinal, sağda Türkçe (ya da seçilen başka bir dil). Her şey tarayıcıda çalışır. Çevrilen kitaplar tarayıcının kütüphanesinde saklanır.

## Özellikler

- **Dört sayfa düzeni**
  - Yan Yana (Tablo): her okuyucuda çalışır, eski Kindle'lar dahil.
  - Yan Yana (Mobil Uyumlu): geniş ekranda yan yana durur, telefonda alt alta geçer.
  - Satır Arası: çeviri, orijinal paragrafın hemen altında.
  - Sadece Çeviri: orijinal metin çeviriyle değiştirilir.
- **Kitabın yapısı korunur.** İtalik, link, dipnot ve resimler yerinde kalır. İçindekiler çevrilmez, linkleri çalışmaya devam eder.
- **Çeviri motorları**
  - Google Translate: ücretsiz.
  - Gemini: kendi API anahtarınızla. Önceki paragraflar ve kitaptaki karakter isimleri bağlam olarak gönderilir.
  - İkisinin birlikte kullanımı: Google başarısız olursa Gemini devreye girer.
- **Kalıcı önbellek.** Çevrilen her paragraf tarayıcıda saklanır. Yarım kalan bir çeviriye devam ederken ya da aynı kitabı başka bir düzenle yeniden üretirken bu paragraflar tekrar çevrilmez.
- **Zorluk analizi.** Kitaptaki kelimeler kullanım sıklığına göre CEFR seviyelerine ayrılır. Uygulama, seviyenize göre metnin ne kadarını anlayabileceğinizi ve hangi kelimeleri öğrenmeniz gerektiğini gösterir.
- **Otomatik sözlük.** Seçilen seviyenin üstündeki kelimeler ve deyimler, geçtikleri cümleyle birlikte kitabın sonuna eklenir. Sözlük içindekiler listesinde de yer alır.
- **Doğru metaveri.** Çıktı EPUB'da hedef dil `dc:language` alanına eklenir, başlığa da `(EN–TR)` etiketi gelir. Çeviri paragrafları `lang`/`xml:lang` ile işaretlenir; böylece okuyucular doğru sesle okur ve doğru heceler.

## Çalıştırma

Node.js gerekir.

```bash
npm install
npm run dev      # http://localhost:3000 — çeviri vekil sunucusu (server.ts) ile birlikte
npm test         # birim testleri (vitest)
npm run lint     # tür denetimi
npm run build    # üretim derlemesi: dist/
```

Google Translate istekleri `server.ts` içindeki `/api/process-text` vekili üzerinden gider. Uygulama, vekil olmayan statik bir sunucuda (Netlify, GitHub Pages) yayınlanırsa doğrudan Google'a istek atar. Bu yol tarayıcı kısıtlamalarına (CORS) takılabilir, o yüzden statik yayında Gemini daha güvenilir çalışır.

Gemini API anahtarı yalnızca tarayıcıda (localStorage) saklanır ve doğrudan Google'a gönderilir. Ayarlardaki "Tüm Verileri Sıfırla" düğmesi anahtarı, önbelleği ve kütüphaneyi siler.

## Yapı

```
src/
  App.tsx            Arayüz ve çeviri akışı
  types.ts           Ortak türler
  constants.ts       Diller, deyim listesi
  lib/epub.ts        EPUB okuma/yazma: yol çözme, blok seçimi, vurgulama, düzenler, OPF/nav/NCX
  lib/translate.ts   Çeviri motoru: Google/Gemini, ayraç bölme, önbellek
  lib/cefr.ts        Sıklığa dayalı CEFR analizi
  lib/db.ts          IndexedDB/localStorage: kütüphane, önbellek, ayarlar, yarım kalan iş
  data/en-freq.txt   En sık 10.000 İngilizce kelime
server.ts            Geliştirme sunucusu ve Google Translate vekili
```

## Veri kaynağı

`src/data/en-freq.txt`, Hermit Dave'in [FrequencyWords](https://github.com/hermitdave/FrequencyWords) projesinden (OpenSubtitles 2018) alınmıştır ve [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) lisanslıdır. CEFR seviyeleri bu sıralamadan tahmin edilir: en sık 700 kelime A1, 1500 A2, 3000 B1, 5000 B2, 10.000 C1, ötesi C2. Bu bir yaklaşık değerdir, resmi bir CEFR listesi değildir.
