# Anousith Express - Auto Bill Sending WhatsApp Bot

ລະບົບກວດສອບອໍເດີພັດສະດຸໃໝ່ຈາກ Anousith Express ດາວໂຫຼດຮູບໃບບິນ ແລະ ສົ່ງເຂົ້າ WhatsApp ຂອງລູກຄ້າອັດຕະໂນມັດ ໂດຍບໍ່ຕ້ອງສົ່ງດ້ວຍຕົນເອງເທື່ອລະຄົນ.

---

## 🚀 ວິທີຕິດຕັ້ງ ແລະ ໃຊ້ງານ (How to Run)

### 1. ຕັ້ງຄ່າຂໍ້ມູນ `.env`
ສ້າງໄຟລ໌ `.env` ໂດຍກັອບປີ້ຈາກ `.env.example`:
```env
ANOUSITH_USERNAME=020xxxxxxxx
ANOUSITH_PASSWORD=ລະຫັດຜ່ານຂອງທ່ານ
ANOUSITH_BASE_URL=https://app.anousith.express
POLL_INTERVAL_SECONDS=60
```

### 2. ເລີ່ມຕົ້ນຣັນ Bot
```bash
npm start
```
ຫຼື:
```bash
node src/index.js
```

### 3. ສະແກນ QR Code
ເມື່ອຣັນຄຳສັ່ງແລ້ວ ຈະມີ **QR Code** ຂຶ້ນມາໃນ Terminal/Console:
1. ເປີດ **WhatsApp** ໃນໂທລະສັບມືຖື
2. ໄປທີ່ **Settings (ຫຼື 3 ຈຸດ)** -> **Linked Devices (ອຸປະກອນທີ່ເຊື່ອມຕໍ່)**
3. ກົດ **Link a Device** ແລ້ວສະແກນ QR Code ທີ່ໜ້າຈໍ

---

## ⚡ ຄຸນສົມບັດຫຼັກ
1. **Auto Poll & Send:** ກວດສອບອໍເດີໃໝ່ໃນລະບົບ Anousith ທຸກໆ 60 ວິນາທີ ແລະ ສົ່ງຮູບໃບບິນຫາເບີຜູ້ຮັບອັດຕະໂນມັດ.
2. **Duplicate Prevention:** ມີຖານຂໍ້ມູນບັນທຶກເລກບິນ ປ້ອງກັນການສົ່ງບິນຊ້ຳຊ້ອນຫາລູກຄ້າ.
3. **Lao Phone Formatter:** ແປງເບີໂທລາວອັດຕະໂນມັດ (ຮອງຮັບທັງ `020...`, `030...`, `+85620...`).
4. **Interactive Command:** ສາມາດພິມສັ່ງງານຜ່ານ WhatsApp ໄດ້ ເຊັ່ນ: `/bill 8707221950159 02099999999` ເພື່ອສົ່ງໃບບິນໃຫ້ລູກຄ້າແບບ manual.

---

## 📁 ໂຄງສ້າງໂຟນເດີ (Project Structure)
```text
Company messenger/
├── data/
│   └── sent_bills.json       # ຖານຂໍ້ມູນເກັບປະຫວັດເລກບິນທີ່ສົ່ງແລ້ວ
├── src/
│   ├── anousith.js           # ລະບົບເຊື່ອມຕໍ່ Anousith Express API
│   ├── db.js                 # ຈັດການບັນທຶກຂໍ້ມູນ
│   ├── formatter.js          # ແປງ Format ເບີໂທລະສັບລາວ -> WhatsApp JID
│   ├── whatsapp.js           # WhatsApp Client (Baileys)
│   └── index.js              # ໂປຣແກຣມຫຼັກ (Worker Loop)
├── test/
│   └── test_formatter.js     # Unit test
├── .env.example
├── package.json
└── README.md
```
