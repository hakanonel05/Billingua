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
  - Açık kaynak yapay zeka: Qwen, Llama, Gemma, Mistral gibi modeller, OpenAI uyumlu her sunucu üzerinden. Önce Google hızlı bir taslak çıkarır, model bu taslağı orijinalle karşılaştırıp düzeltir: kelimesi kelimesine çevrilmiş deyimleri, yanlış anlamları ve doğal olmayan söz dizimini giderir. Model ayrıca kitabın adını ve yazarını, karakter isimlerini ve önceki paragrafların nasıl çevrildiğini görür. Böylece isimler, terimler ve sen/siz kullanımı kitap boyunca tutarlı kalır, deyimler kelime kelime değil anlamıyla çevrilir. Kalite modele bağlıdır. Bir Doctor Who romanında yapılan karşılaştırmada Groq'taki `qwen/qwen3.8-27b` + Google taslağı, Google'dan belirgin şekilde daha iyi sonuç verdi; `openai/gpt-oss-120b` ise Türkçede Google'ı geçemedi. Dizüstü bilgisayarda çalışan 4B sınıfı küçük modeller genellikle Google'ın gerisinde kalır.
  - İkisinin birlikte kullanımı: Google başarısız olursa yapay zeka devreye girer.
- **Metni sadeleştirme.** C1/C2 bir kitabın İngilizcesi yapay zeka ile B2, B1 ya da A2 seviyesinde yeniden yazılır (graded reader). Türkçe çeviri sade metinden yapılır; başlık `(EN–TR, B1)` olur.
- **PDF olarak indirme.** EPUB'ın yanında aynı kitabın PDF'i de indirilebilir: yan yana sütunlar, resimler ve sayfa numaralarıyla. Kütüphanedeki eski kitaplar da PDF'e çevrilebilir. PDF yazı tipi Latin, Yunan ve Kiril alfabelerini kapsar; Japonca, Arapça gibi diller için EPUB kullanın.
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

Google Translate istekleri `server.ts` içindeki `/api/process-text` vekili üzerinden gider. Uygulama, vekil olmayan statik bir sunucuda (Netlify, GitHub Pages) yayınlanırsa doğrudan Google'a istek atar. Bu yol tarayıcı kısıtlamalarına (CORS) takılabilir, o yüzden statik yayında yapay zeka motoru daha güvenilir çalışır.

### Açık kaynak yapay zeka

Yapay zeka seçenekleri (çeviri motoru ya da sadeleştirme), OpenAI uyumlu `/v1/chat/completions` API'sini konuşan her sunucuyla çalışır. Ayarlarda hazır seçenekler var:

| Seçenek | Nerede çalışır | Anahtar |
|---|---|---|
| [Ollama](https://ollama.com) | Kendi bilgisayarınızda, ücretsiz | Gerekmez |
| [LM Studio](https://lmstudio.ai) | Kendi bilgisayarınızda, ücretsiz | Gerekmez |
| [Groq](https://console.groq.com) | Bulutta, açık modeller | Gerekir (ücretsiz katman var) |
| [OpenRouter](https://openrouter.ai) | Bulutta, açık modeller | Gerekir |
| Diğer | llama.cpp, vLLM gibi | Sunucuya göre |

Ollama ile başlamak için:

```bash
ollama pull gemma3:4b
```

Ardından ayarlardan "Ollama"yı seçip "Modelleri getir" düğmesine basın. Büyük modeller (`gemma3:12b`, `qwen2.5:14b`) daha iyi çevirir ama daha yavaştır. Uygulamayı localhost dışında bir adresten açıyorsanız Ollama'yı `OLLAMA_ORIGINS` ortam değişkeniyle o adrese izin verecek şekilde başlatın. LM Studio'da sunucu ayarlarından "Enable CORS" açılmalıdır.

API anahtarı yalnızca tarayıcıda (localStorage) saklanır ve doğrudan seçtiğiniz sunucuya gönderilir. Ayarlardaki "Tüm Verileri Sıfırla" düğmesi anahtarı, önbelleği ve kütüphaneyi siler.

## Yapı

```
src/
  App.tsx            Arayüz ve çeviri akışı
  types.ts           Ortak türler
  constants.ts       Diller, deyim listesi
  lib/epub.ts        EPUB okuma/yazma: yol çözme, blok seçimi, vurgulama, düzenler, OPF/nav/NCX
  lib/translate.ts   Çeviri motoru: Google / yapay zeka, ayraç bölme, sadeleştirme, önbellek
  lib/llm.ts         OpenAI uyumlu sunucu istemcisi (Ollama, LM Studio, Groq, OpenRouter...)
  lib/pdf.ts         EPUB'dan PDF üretimi (pdfmake)
  lib/cefr.ts        Sıklığa dayalı CEFR analizi
  lib/db.ts          IndexedDB/localStorage: kütüphane, önbellek, ayarlar, yarım kalan iş
  data/en-freq.txt   En sık 10.000 İngilizce kelime
server.ts            Geliştirme sunucusu ve Google Translate vekili
```

## Veri kaynağı

`src/data/en-freq.txt`, Hermit Dave'in [FrequencyWords](https://github.com/hermitdave/FrequencyWords) projesinden (OpenSubtitles 2018) alınmıştır ve [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) lisanslıdır. CEFR seviyeleri bu sıralamadan tahmin edilir: en sık 700 kelime A1, 1500 A2, 3000 B1, 5000 B2, 10.000 C1, ötesi C2. Bu bir yaklaşık değerdir, resmi bir CEFR listesi değildir.
