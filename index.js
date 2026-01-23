const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');
const moment = require('moment-timezone');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const nodemailer = require('nodemailer');
const twilio = require('twilio');

const app = express();
app.use(cors());
app.use(express.json());

// 🔐 Konfigurasi Kredensial Umum
const clientId = "088e21fc-de14-4df5-9008-f545ecd28ad1";
const clientSecret = "p8OOlsOexX5AdDSOgHx1y65Bw";
const username = "LI264GULM";
const pin = "bCY3o1jPJe1JHcI";
const serverKey = "AArMxIUKKz8WZfzdSXcILkiy";

// ADMIN DATA
const ADMIN_PHONE = '6282323907426';
const ADMIN_EMAIL = 'kilaufast@gmail.com';

// 📧 Konfigurasi Nodemailer
const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: {
        user: 'kilaufast@gmail.com',
        pass: 'xvtbjkrzjzriosca',
    },
    tls: {
        rejectUnauthorized: true,
    },
});

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_ACCOUNT_TOKEN;
const twilioClient = twilio(accountSid, authToken);
const twilioFrom = 'whatsapp:+62882005447472';

// 🐘 Konfigurasi Database
const db = mysql.createPool({
    host: '203.161.184.103',
    user: 'kilaugr1_layanan',
    password: '~)ea$[r179HegfyL',
    database: 'kilaugr1_layanan',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// --- FUNGSI UTILITY ---

function logToFile(message) {
    const logPath = path.join(__dirname, 'stderr.log');
    const timestamp = new Date().toISOString();
    const fullMessage = `[${timestamp}] ${message}\n`;
    fs.appendFile(logPath, fullMessage, (err) => {
        if (err) console.error("❌ Gagal menulis log:", err);
    });
}

function getExpiredTimestamp(minutesFromNow = 1440) {
    return moment.tz('Asia/Jakarta').add(minutesFromNow, 'minutes').format('YYYYMMDDHHmmss');
}

function generateSignaturePOST(data, path) {
    const method = 'POST';
    const paramsOrder = path.includes('/va') ?
        ['amount', 'expired', 'bank_code', 'partner_reff', 'customer_id', 'customer_name', 'customer_email', 'clientId'] :
        path.includes('/qris') ?
            ['amount', 'expired', 'partner_reff', 'customer_id', 'customer_name', 'customer_email', 'clientId'] : [];

    let rawValue = paramsOrder.map(key => data[key] || '').join('');
    const cleaned = rawValue.replace(/[^0-9a-zA-Z]/g, "").toLowerCase();
    const signToString = path + method + cleaned;
    return crypto.createHmac("sha256", serverKey).update(signToString).digest("hex");
}

function generatePartnerReff() {
    const prefix = 'INV';
    const timestamp = moment().tz('Asia/Jakarta').format('YYYYMMDDHHmmss');
    const randomStr = crypto.randomBytes(3).toString('hex').toUpperCase();
    return `${prefix}-${timestamp}-${randomStr}`;
}

const formatIDR = (amount) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(amount);

// ------------------------------------
// 📧 FUNGSI EMAIL (DENGAN FALLBACK)
// ------------------------------------

async function sendEmailNotification(to, subject, htmlContent) {
    try {
        await transporter.sendMail({
            from: ADMIN_EMAIL,
            to: to,
            subject: subject,
            html: htmlContent,
        });
        return { status: true };
    } catch (error) {
        logToFile(`❌ Gagal kirim email ke ${to}: ${error.message}`);
        if (to !== ADMIN_EMAIL) {
            await transporter.sendMail({
                from: ADMIN_EMAIL,
                to: ADMIN_EMAIL,
                subject: `[FAILED DELIVERY] ${subject}`,
                html: `<p>Email ke <b>${to}</b> gagal. Berikut isinya:</p><hr>${htmlContent}`,
            });
        }
        return { status: false };
    }
}

// ------------------------------------
// 📱 FUNGSI WHATSAPP
// ------------------------------------

function formatToWhatsAppNumber(localNumber) {
    if (!localNumber) return null;
    const cleanNumber = localNumber.toString().replace(/\D/g, '');
    if (cleanNumber.startsWith('0')) return `+62${cleanNumber.slice(1)}`;
    if (cleanNumber.startsWith('62')) return `+${cleanNumber}`;
    return `+${cleanNumber}`;
}

async function sendWhatsAppWithTemplate(to, variables) {
    const formattedTo = formatToWhatsAppNumber(to);
    try {
        const response = await twilioClient.messages.create({
            from: twilioFrom,
            to: `whatsapp:${formattedTo}`,
            contentSid: 'HX83d2f6ce8fa5693a942935bb0f44a77d',
            // Twilio Node Helper membutuhkan object murni
            contentVariables: JSON.stringify(variables)
        });
        console.log(`✅ WA Sukses terkirim ke ${formattedTo}. SID: ${response.sid}`);
        return { status: true, sid: response.sid };
    } catch (error) {
        console.error(`❌ Gagal kirim WA ke ${formattedTo}:`, error.message);
        return { status: false };
    }
}

async function insertOrderService(body, partnerReff) {
    const now = new Date();
    const extraServicesJson = body.jasaTambahan ? JSON.stringify(body.jasaTambahan) : null;
    const extraServicesPrice = body.jasaTambahan ? body.jasaTambahan.reduce((acc, curr) => acc + curr.harga, 0) : 0;

    const [result] = await db.execute(
        `INSERT INTO order_service (
            order_reff, customer_name, customer_phone, customer_email, 
            service_name, service_price, location, address, notes,
            extra_services, extra_services_price, building_type, building_fee, 
            total_amount, payment_method, payment_code, partner_name, partner_phone, 
            schedule_date, schedule_time, order_status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_PAYMENT', ?, ?)`,
        [
            partnerReff, body.kontak.nama, body.kontak.telepon, body.kontak.email,
            body.layanan.nama, body.layanan.harga, body.lokasi, body.alamat, body.catatan || null,
            extraServicesJson, extraServicesPrice, body.jenisGedung, body.biayaGedung,
            body.totalBayar, body.metodePembayaran.name, body.metodePembayaran.code,
            body.kontak.nama, body.kontak.telepon, body.jadwal.tanggal, body.jadwal.jam,
            now, now
        ]
    );
    return result.insertId;
}

async function getOrderDetails(partnerReff) {
    const [rows] = await db.query('SELECT * FROM order_service WHERE order_reff = ?', [partnerReff]);
    return rows[0] || null;
}

// async function getCurrentStatusVa(partnerReff) {
//     const [rows] = await db.execute('SELECT status FROM inquiry_va WHERE partner_reff = ?', [partnerReff]);
//     return rows.length > 0 ? rows[0].status : null;
// }

// async function getCurrentStatusQris(partnerReff) {
//     const [rows] = await db.execute('SELECT status FROM inquiry_qris WHERE partner_reff = ?', [partnerReff]);
//     return rows.length > 0 ? rows[0].status : null;
// }

app.post('/create-pay-saldo', async (req, res) => {
    console.log("-----------------------------------------");
    console.log("🚀 [INCOMING REQUEST] /create-pay-saldo");
    console.log("📦 Payload:", JSON.stringify(req.body));

    const JAGEL_API_KEY = 'z4PBduE9ocedWaaTUCKHnOl7C8yokkTB4catk7FMt5U2d4Lmyv';

    try {
        const body = req.body;
        const userEmail = body.kontak?.email;
        const totalBayar = body.totalBayar;

        // Validasi awal data input
        if (!userEmail || !totalBayar) {
            console.error("❌ [VALIDATION ERROR] Email atau Total Bayar kosong");
            return res.status(400).json({ error: "Data kontak atau nominal tidak lengkap" });
        }

        // --- STEP 1: CEK SALDO KE JAGEL ---
        console.log(`🔍 [STEP 1] Checking balance for: ${userEmail}`);
        
        const checkRes = await axios.post('https://api.jagel.id/v1/balance/check', {
            type: "email",
            value: userEmail,
            apikey: JAGEL_API_KEY
        }, { 
            headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
            timeout: 10000 // Timeout 10 detik
        });

        // Debugging jika Jagel kirim HTML (Error 500/404)
        if (typeof checkRes.data === 'string' && checkRes.data.includes('<html>')) {
            console.error("⛔ [JAGEL ERROR] Server Jagel mengirim HTML, bukan JSON. Cek API Key/Endpoint.");
            throw new Error("Server Jagel memberikan respon tidak valid (HTML).");
        }

        console.log("📩 [JAGEL RESPONSE - CHECK]:", checkRes.data);
        const currentBalance = checkRes.data.balance || 0;

        if (currentBalance < totalBayar) {
            console.warn(`⚠️ [INSUFFICIENT BALANCE] User: ${userEmail}, Balance: ${currentBalance}, Need: ${totalBayar}`);
            return res.status(400).json({
                status: 'error',
                message: `Saldo tidak mencukupi. Saldo Anda: Rp${currentBalance.toLocaleString()}, Dibutuhkan: Rp${totalBayar.toLocaleString()}`
            });
        }

        // --- STEP 2: GENERATE REFF & DATA ---
        console.log("🛠️ [STEP 2] Generating references and notes...");
        const partner_reff = typeof generatePartnerReff === 'function' ? generatePartnerReff() : `TF${Date.now()}`;
        
        const detailJasaStr = body.jasaTambahan?.length > 0
            ? body.jasaTambahan.map(j => j.nama).join(', ')
            : 'Tanpa tambahan';

        const catatanJagel = `Bayar: ${body.layanan?.nama} | Jadwal: ${body.jadwal?.tanggal} | Reff: ${partner_reff}`;

        // --- STEP 3: POTONG SALDO (ADJUST BALANCE) ---
        console.log(`💸 [STEP 3] Deducting balance: -${totalBayar}`);
        const adjustRes = await axios.post('https://api.jagel.id/v1/balance/adjust', {
            type: "email",
            value: userEmail,
            apikey: JAGEL_API_KEY,
            amount: -totalBayar, // Nilai negatif untuk memotong saldo
            adjust_balance_admin: 1, 
            note: catatanJagel
        }, { headers: { 'Accept': 'application/json' } });

        console.log("📩 [JAGEL RESPONSE - ADJUST]:", adjustRes.data);

        if (adjustRes.data.status !== 'success') {
            console.error("❌ [JAGEL ERROR] Adjustment failed:", adjustRes.data);
            throw new Error(`Jagel Error: ${adjustRes.data.message || "Gagal memotong saldo"}`);
        }

        // --- STEP 4: SIMPAN KE DATABASE ---
        console.log("💾 [STEP 4] Saving to Database...");
        let orderServiceId;
        try {
            // 1. Simpan pesanan utama
            orderServiceId = await insertOrderService(body, partner_reff);
            
            // 2. Simpan log inquiry sebagai PAID
            const inquiryData = {
                order_service_id: orderServiceId,
                partner_reff,
                customer_id: body.kontak.nama,
                amount: totalBayar,
                bank_name: "SALDO JAGEL",
                expired: typeof getExpiredTimestamp === 'function' ? getExpiredTimestamp() : new Date(),
                va_number: "PAID_VIA_SALDO",
                response_raw: JSON.stringify(adjustRes.data),
                created_at: new Date(),
                status: "PAID"
            };

            await db.query('INSERT INTO inquiry_va SET ?', [inquiryData]);

            // 3. Update status pesanan langsung menjadi PAID
            await db.query('UPDATE order_service SET order_status = "PAID" WHERE id = ?', [orderServiceId]);
            
            console.log("✅ Database record complete (Order + Inquiry + Status PAID)");

        } catch (dbErr) {
            console.error("❌ [DATABASE ERROR]:", dbErr.message);
            // Catatan: Saldo sudah terpotong di Jagel, jika DB gagal ini butuh penanganan manual/log khusus
            throw new Error("Saldo terpotong namun gagal menyimpan data ke database. Hubungi Admin.");
        }

        // --- STEP 5: KIRIM EMAIL NOTIFIKASI ---
        console.log("📧 [STEP 5] Sending confirmation email...");
        try {
            const emailHTML = `
                <div style="font-family: sans-serif; color: #333; max-width: 600px; margin: auto; border: 1px solid #eee; padding: 25px; border-radius: 15px;">
                    <div style="text-align: center; margin-bottom: 20px;">
                        <h2 style="color: #22c55e;">PEMBAYARAN BERHASIL</h2>
                        <p style="color: #666;">ID Transaksi: ${partner_reff}</p>
                    </div>
                    <p>Halo <b>${body.kontak.nama}</b>,</p>
                    <p>Pembayaran menggunakan <b>Saldo</b> untuk layanan <b>${body.layanan.nama}</b> telah lunas diverifikasi.</p>
                    <table style="width: 100%; border-top: 1px solid #eee; margin-top: 15px;">
                        <tr><td style="padding: 10px 0;">Total Bayar</td><td style="text-align: right; font-weight: bold; color: #22c55e;">Rp${totalBayar.toLocaleString()}</td></tr>
                    </table>
                    <p style="font-size: 12px; color: #999; text-align: center; margin-top: 20px;">Pesanan Anda sedang kami proses. Terima kasih!</p>
                </div>`;

            await sendEmailNotification(userEmail, `Lunas: Pembayaran #${partner_reff}`, emailHTML);
            console.log("✅ Email Notification Sent");
        } catch (mailErr) {
            console.warn("⚠️ [EMAIL WARNING] Email gagal terkirim, tapi transaksi tetap sukses:", mailErr.message);
        }

        res.json({ 
            status: 'success', 
            message: 'Pembayaran berhasil menggunakan saldo', 
            partner_reff 
        });

    } catch (err) {
        console.error("🔥 [FATAL ERROR] /create-pay-saldo:");
        if (err.response) {
            // Error dari Axios (HTTP Error)
            console.error("API Response Data:", err.response.data);
            console.error("API Status Code:", err.response.status);
        } else {
            console.error("System Error Stack:", err.stack);
        }
        
        res.status(500).json({ 
            status: 'error', 
            error: "Gagal memproses pembayaran saldo",
            message: err.message 
        });
    }
});

app.post('/create-va', async (req, res) => {
    console.log("-----------------------------------------");
    console.log("🚀 [REQUEST] /create-va", JSON.stringify(req.body));

    try {
        const body = req.body;
        const partner_reff = generatePartnerReff();
        const expired = getExpiredTimestamp();

        const orderServiceId = await insertOrderService(body, partner_reff);

        const signature = generateSignaturePOST({
            amount: body.totalBayar, expired, bank_code: body.metodePembayaran.code,
            partner_reff, customer_id: body.kontak.nama, customer_name: body.kontak.nama,
            customer_email: body.kontak.email, clientId
        }, '/transaction/create/va');

        const response = await axios.post('https://api.linkqu.id/linkqu-partner/transaction/create/va', {
            amount: body.totalBayar, bank_code: body.metodePembayaran.code, partner_reff,
            username, pin, expired, signature, customer_id: body.kontak.nama,
            customer_name: body.kontak.nama, customer_email: body.kontak.email,
            url_callback: "https://layanan.tangerangfast.online/callback"
        }, { headers: { 'client-id': clientId, 'client-secret': clientSecret } });

        const result = response.data;

        await db.query('INSERT INTO inquiry_va SET ?', [{
            order_service_id: orderServiceId, partner_reff, customer_id: body.kontak.nama,
            amount: body.totalBayar, bank_name: result?.bank_name || body.metodePembayaran.name,
            expired, va_number: result?.virtual_account, response_raw: JSON.stringify(result),
            created_at: new Date(), status: "PENDING"
        }]);

        // --- TEMPLATE EMAIL PROFESIONAL VA ---
        const detailJasa = body.jasaTambahan.length > 0 ? body.jasaTambahan.map(j => j.nama).join(', ') : '-';
        const emailHTML = `
        <div style="font-family: sans-serif; color: #333; max-width: 600px; margin: auto; border: 1px solid #eee; padding: 20px; border-radius: 15px;">
            <div style="text-align: center; margin-bottom: 20px;">
                <h2 style="color: #0194f3; margin: 0;">INVOICE PEMBAYARAN</h2>
                <p style="font-size: 12px; color: #999;">ID Transaksi: ${partner_reff}</p>
            </div>
            <p>Halo <b>${body.kontak.nama}</b>,</p>
            <p>Pesanan Anda telah diterima. Silakan lakukan pembayaran melalui <b>Virtual Account</b> berikut:</p>
            
            <div style="background: #f0f9ff; border: 1px dashed #0194f3; padding: 15px; text-align: center; border-radius: 10px; margin: 20px 0;">
                <span style="font-size: 14px; color: #666;">Nomor Virtual Account (${result?.bank_name || body.metodePembayaran.name})</span><br>
                <b style="font-size: 24px; color: #0194f3;">${result?.virtual_account}</b>
            </div>

            <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
                <tr style="border-bottom: 1px solid #eee;"><td style="padding: 10px 0;">Layanan</td><td style="text-align: right; font-weight: bold;">${body.layanan.nama}</td></tr>
                <tr style="border-bottom: 1px solid #eee;"><td style="padding: 10px 0;">Jadwal</td><td style="text-align: right; font-weight: bold;">${body.jadwal.tanggal} | ${body.jadwal.jam}</td></tr>
                <tr style="border-bottom: 1px solid #eee;"><td style="padding: 10px 0;">Tambahan</td><td style="text-align: right;">${detailJasa}</td></tr>
                <tr style="border-bottom: 1px solid #eee;"><td style="padding: 10px 0;">Alamat</td><td style="text-align: right; font-size: 12px;">${body.alamat}, ${body.lokasi}</td></tr>
                <tr><td style="padding: 15px 0; font-size: 18px;"><b>Total Bayar</b></td><td style="text-align: right; font-size: 18px; color: #0194f3;"><b>${formatIDR(body.totalBayar)}</b></td></tr>
            </table>

            <p style="font-size: 12px; color: #ef4444; text-align: center; background: #fef2f2; padding: 10px; border-radius: 5px;">
                ⚠ Mohon selesaikan pembayaran sebelum batas waktu yang ditentukan.
            </p>
        </div>`;

        await sendEmailNotification(body.kontak.email, `Instruksi Pembayaran #${partner_reff}`, emailHTML);

        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/create-qris', async (req, res) => {
    console.log("-----------------------------------------");
    console.log("🚀 [REQUEST] /create-qris", JSON.stringify(req.body));

    try {
        const body = req.body;
        const partner_reff = generatePartnerReff();
        const expired = getExpiredTimestamp();

        // 1. Simpan ke tabel utama order_service
        const orderServiceId = await insertOrderService(body, partner_reff);

        // 2. Generate Signature untuk LinkQu
        const signature = generateSignaturePOST({
            amount: body.totalBayar, expired, partner_reff, customer_id: body.kontak.nama,
            customer_name: body.kontak.nama, customer_email: body.kontak.email, clientId
        }, '/transaction/create/qris');

        // 3. Tembak API LinkQu
        console.log("📡 Sending Request to LinkQu API (QRIS)...");
        const response = await axios.post('https://api.linkqu.id/linkqu-partner/transaction/create/qris', {
            amount: body.totalBayar, partner_reff, username, pin, expired, signature,
            customer_id: body.kontak.nama, customer_name: body.kontak.nama,
            customer_email: body.kontak.email, url_callback: "https://layanan.tangerangfast.online/callback"
        }, { headers: { 'client-id': clientId, 'client-secret': clientSecret } });

        const result = response.data;
        console.log("✅ [LINKQU RES]", JSON.stringify(result));

        // 4. DOWNLOAD GAMBAR QRIS UNTUK SIMPAN SEBAGAI BLOB
        let qrisBuffer = null;
        if (result?.imageqris) {
            try {
                console.log("📥 Downloading QRIS Image for BLOB storage...");
                const imgRes = await axios.get(result.imageqris, { responseType: 'arraybuffer' });
                qrisBuffer = Buffer.from(imgRes.data);
                console.log("📂 QRIS converted to Buffer successfully.");
            } catch (downloadErr) {
                console.error("❌ Failed to download QRIS image for BLOB:", downloadErr.message);
            }
        }

        // 5. Simpan ke tabel inquiry_qris (Termasuk kolom BLOB qris_image)
        await db.execute(
            `INSERT INTO inquiry_qris (order_service_id, partner_reff, customer_id, amount, expired, qris_url, qris_image, response_raw, created_at, status) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), 'PENDING')`,
            [orderServiceId, partner_reff, body.kontak.nama, body.totalBayar, expired, result?.imageqris, qrisBuffer, JSON.stringify(result)]
        );

        // 6. KIRIM EMAIL PROFESIONAL
        const detailJasa = body.jasaTambahan.length > 0 ? body.jasaTambahan.map(j => j.nama).join(', ') : '-';
        const emailHTML = `
        <div style="font-family: sans-serif; color: #333; max-width: 600px; margin: auto; border: 1px solid #eee; padding: 20px; border-radius: 15px;">
            <div style="text-align: center; margin-bottom: 20px;">
                <h2 style="color: #22c55e; margin: 0;">INVOICE PEMBAYARAN QRIS</h2>
                <p style="font-size: 12px; color: #999;">ID Transaksi: ${partner_reff}</p>
            </div>
            
            <p>Halo <b>${body.kontak.nama}</b>,</p>
            <p>Silakan lakukan pembayaran dengan melakukan scan pada kode QRIS di bawah ini:</p>
            
            <div style="text-align: center; margin: 25px 0; padding: 20px; background: #f9fafb; border-radius: 10px;">
                <img src="${result?.imageqris}" alt="QRIS Code" style="width: 250px; height: 250px; border: 5px solid #fff; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1);">
                <p style="margin-top: 10px; font-weight: bold; color: #374151;">Scan menggunakan aplikasi bank atau e-wallet Anda</p>
            </div>

            <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
                <tr style="border-bottom: 1px solid #eee;"><td style="padding: 10px 0; color: #666;">Layanan</td><td style="text-align: right; font-weight: bold;">${body.layanan.nama}</td></tr>
                <tr style="border-bottom: 1px solid #eee;"><td style="padding: 10px 0; color: #666;">Jadwal Kerja</td><td style="text-align: right; font-weight: bold;">${body.jadwal.tanggal} | ${body.jadwal.jam}</td></tr>
                <tr style="border-bottom: 1px solid #eee;"><td style="padding: 10px 0; color: #666;">Tambahan Jasa</td><td style="text-align: right;">${detailJasa}</td></tr>
                <tr style="border-bottom: 1px solid #eee;"><td style="padding: 10px 0; color: #666;">Lokasi Kerja</td><td style="text-align: right; font-size: 12px;">${body.alamat}, ${body.lokasi}</td></tr>
                <tr><td style="padding: 15px 0; font-size: 18px;"><b>Total Bayar</b></td><td style="text-align: right; font-size: 18px; color: #22c55e;"><b>${formatIDR(body.totalBayar)}</b></td></tr>
            </table>

            <div style="background: #f8fafc; padding: 15px; border-radius: 8px; font-size: 12px; color: #475569;">
                <b>Catatan:</b> ${body.catatan || 'Tidak ada catatan tambahan.'}
            </div>
        </div>`;

        console.log(`📧 Sending Professional Email QRIS to: ${body.kontak.email}`);
        await sendEmailNotification(body.kontak.email, `Tagihan Pembayaran QRIS #${partner_reff}`, emailHTML);

        console.log("🏁 Process /create-qris Done.");
        res.json(result);

    } catch (err) {
        console.error("❌ [ERROR] /create-qris:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// --- ENDPOINT CALLBACK ---
app.post('/callback', async (req, res) => {
    console.log("-----------------------------------------");
    console.log("🔔 [CALLBACK RECEIVED] Data:", JSON.stringify(req.body));

    const reffFromCallback = req.body.partner_reff || req.body.qris_id;

    try {
        // 1. Ambil data pesanan
        const [orders] = await db.execute(
            'SELECT * FROM order_service WHERE order_reff = ?',
            [reffFromCallback]
        );

        const orderData = orders[0];
        if (!orderData) {
            console.warn(`⚠️ Order #${reffFromCallback} tidak ditemukan.`);
            return res.status(404).json({ error: "Order Not Found" });
        }

        // 2. Cek status lunas (Cegah duplikasi)
        // Jika sudah PAID, segera hentikan proses agar WA/Email tidak terkirim lagi
        if (orderData.order_status === 'PAID') {
            console.log(`ℹ️ Order #${reffFromCallback} sudah LUNAS.`);
            return res.json({ message: "Already Processed" });
        }

        // 3. Update Database (Lakukan SEBELUM notifikasi dikirim)
        const methodType = req.body.va_code === 'QRIS' ? 'QRIS' : 'VA';
        const logTable = methodType === 'QRIS' ? 'inquiry_qris' : 'inquiry_va';

        await db.execute(
            `UPDATE ${logTable} SET status = 'SUKSES', callback_raw = ?, updated_at = NOW() WHERE partner_reff = ?`,
            [JSON.stringify(req.body), reffFromCallback]
        );
        
        // PENTING: Update status menjadi PAID di sini agar callback susulan tertolak di Poin 2
        await db.execute(
            `UPDATE order_service SET order_status = 'PAID', updated_at = NOW() WHERE order_reff = ?`,
            [reffFromCallback]
        );

        console.log(`✅ Order #${reffFromCallback} set to PAID. Preparing notifications...`);

        // 4. Olah Data Detail & Format Tanggal (Fix: Rabu, 28 Jan 2026)
        let detailJasa = "-";
        if (orderData.extra_services) {
            try {
                const extras = JSON.parse(orderData.extra_services);
                detailJasa = extras.length > 0 ? extras.map(i => i.nama).join(', ') : "-";
            } catch (e) { detailJasa = "-"; }
        }

        const totalFormatted = new Intl.NumberFormat('id-ID', {
            style: 'currency', currency: 'IDR', minimumFractionDigits: 0
        }).format(orderData.total_amount);

        const tglJadwal = moment(orderData.schedule_date).locale('id').format('dddd, DD MMM YYYY');
        const waktuJadwal = `${tglJadwal} pukul ${orderData.schedule_time} WIB`;

        // 5. Siapkan Variabel WhatsApp
        const waVariables = {
            "1": String(orderData.customer_name),
            "2": String(orderData.order_reff),
            "3": String(orderData.service_name),
            "4": String(detailJasa),
            "5": String(tglJadwal),
            "6": String(orderData.schedule_time),
            "7": String(totalFormatted)
        };

        // --- TEMPLATE EMAIL E-RECEIPT ---
        const emailHtml = `
<div style="font-family: sans-serif; color: #333; max-width: 600px; margin: auto; border: 1px solid #eee; padding: 20px; border-radius: 15px;">
    <div style="text-align: center; margin-bottom: 20px;">
        <div style="background: #22c55e; width: 60px; height: 60px; line-height: 60px; border-radius: 50%; color: white; font-size: 30px; margin: 0 auto 10px;">✓</div>
        <h2 style="color: #22c55e; margin: 0;">PEMBAYARAN BERHASIL</h2>
        <p style="font-size: 14px; color: #666;">Terima kasih, pembayaran Anda telah kami terima.</p>
    </div>

    <div style="border-top: 2px dashed #eee; border-bottom: 2px dashed #eee; padding: 15px 0; margin: 20px 0;">
        <table style="width: 100%; font-size: 14px;">
            <tr><td style="color: #999;">No. Referensi</td><td style="text-align: right; font-weight: bold;">${orderData.order_reff}</td></tr>
            <tr><td style="color: #999;">Metode Pembayaran</td><td style="text-align: right;">${orderData.payment_method}</td></tr>
            <tr><td style="color: #999;">Tanggal Bayar</td><td style="text-align: right;">${moment().locale('id').format('DD MMMM YYYY, HH:mm')} WIB</td></tr>
        </table>
    </div>

    <h3 style="font-size: 16px; border-bottom: 1px solid #eee; padding-bottom: 10px;">Detail Layanan</h3>
    <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
        <tr><td style="padding: 8px 0;">Layanan Utama</td><td style="text-align: right; font-weight: bold;">${orderData.service_name}</td></tr>
        <tr><td style="padding: 8px 0;">Jasa Tambahan</td><td style="text-align: right;">${detailJasa}</td></tr>
        <tr><td style="padding: 8px 0;">Jadwal Pelaksanaan</td><td style="text-align: right; font-weight: bold;">${waktuJadwal}</td></tr>
        <tr><td style="padding: 8px 0;">Lokasi</td><td style="text-align: right; font-size: 12px; color: #666;">${orderData.address}</td></tr>
        <tr style="font-size: 18px; color: #22c55e;">
            <td style="padding: 20px 0;"><b>Total Lunas</b></td>
            <td style="text-align: right; padding: 20px 0;"><b>${totalFormatted}</b></td>
        </tr>
    </table>

    <div style="background: #f8fafc; padding: 15px; border-radius: 10px; font-size: 13px; line-height: 1.6; border-left: 4px solid #633594;">
        <p style="margin: 0; font-weight: bold; color: #633594;">Informasi Selanjutnya:</p>
        <p style="margin: 5px 0 0;">Petugas kami akan datang sesuai jadwal yang telah ditentukan. Mohon pastikan nomor telepon <b>${orderData.customer_phone}</b> aktif untuk koordinasi lebih lanjut.</p>
    </div>

    <p style="text-align: center; font-size: 11px; color: #999; margin-top: 25px;">
        &copy; 2026 <b>TangerangFast</b>. Semua Hak Dilindungi.<br>
        Ini adalah pesan otomatis, mohon tidak membalas email ini.
    </p>
</div>`;

        console.log("🚀 Dispatching Notifications...");

        // --- 1. KIRIM WA PELANGGAN & ADMIN ---
        await sendWhatsAppWithTemplate(orderData.customer_phone, waVariables);
        await sendWhatsAppWithTemplate(ADMIN_PHONE, waVariables);

        // --- 2. NOTIFIKASI JAGEL (Lengkap) ---
        try {
            await axios.post('https://api.jagel.id/v1/message/send', {
                apikey: "z4PBduE9ocedWaaTUCKHnOl7C8yokkTB4catk7FMt5U2d4Lmyv",
                type: 'email',
                value: orderData.customer_email || ADMIN_EMAIL,
                content: `✅ PEMBAYARAN BERHASIL (LUNAS)\n\n` +
                    `Halo ${orderData.customer_name},\n` +
                    `Pesanan ${orderData.order_reff} telah kami terima.\n\n` +
                    `Rincian Detail:\n` +
                    `- Layanan: ${orderData.service_name}\n` +
                    `- Jasa Tambahan: ${detailJasa}\n` +
                    `- Jadwal: ${waktuJadwal}\n` +
                    `- Lokasi: ${orderData.address}\n` +
                    `- Total Bayar: ${totalFormatted}\n\n` +
                    `Teknisi kami akan datang sesuai jadwal. Terima kasih!`
            });
        } catch (e) { console.error("❌ Jagel Error:", e.message); }

        // --- 3. KIRIM EMAIL INVOICE ---
        if (orderData.customer_email) {
            await sendEmailNotification(orderData.customer_email, `E-Receipt Pembayaran Lunas #${reffFromCallback}`, emailHtml);
        }

        res.json({ status: "SUCCESS" });

    } catch (err) {
        console.error("❌ CALLBACK FATAL ERROR:", err.message);
        res.status(500).send("Internal Server Error");
    }
});

app.get('/download-qr/:partner_reff', async (req, res) => {
    const partner_reff = req.params.partner_reff;
    try {
        const [check] = await db.query('SELECT qris_image FROM inquiry_qris WHERE partner_reff = ?', [partner_reff]);
        if (check.length > 0 && check[0].qris_image) {
            res.setHeader('Content-Disposition', `attachment; filename="qris-${partner_reff}.png"`);
            res.setHeader('Content-Type', 'image/png');
            return res.send(check[0].qris_image);
        }

        const [rows] = await db.query('SELECT qris_url FROM inquiry_qris WHERE partner_reff = ?', [partner_reff]);
        if (!rows.length || !rows[0].qris_url) return res.status(404).send('QRIS not found');

        const response = await axios.get(rows[0].qris_url.trim(), { responseType: 'arraybuffer' });
        const buffer = Buffer.from(response.data);

        await db.query('UPDATE inquiry_qris SET qris_image = ? WHERE partner_reff = ?', [buffer, partner_reff]);
        res.setHeader('Content-Disposition', `attachment; filename="qris-${partner_reff}.png"`);
        res.setHeader('Content-Type', 'image/png');
        res.send(buffer);
    } catch (err) {
        res.status(500).send('Server Error');
    }
});

// ⚡ ENDPOINT: Cek Status Transaksi LinkQu (Menggunakan endpoint sederhana)
app.get('/check-status/:partnerReff', async (req, res) => {
    const partner_reff = req.params.partnerReff;

    // Ambil detail order dari database
    const orderData = await getOrderDetails(partner_reff);
    if (!orderData) {
        logToFile(`❌ Check Status: Order ${partner_reff} Not Found in database`);
        return res.status(404).json({ error: "Order Not Found in database" });
    }

    try {
        // Tentukan URL LinkQu sesuai dokumentasi cURL yang baru
        // URL Path: /linkqu-partner/transaction/payment/checkstatus
        const url = `https://api.linkqu.id/linkqu-partner/transaction/payment/checkstatus`;

        const response = await axios.get(url, {
            params: {
                username: username, // Menggunakan username dari konfigurasi global
                partnerreff: partner_reff
            },
            headers: {
                'client-id': clientId, // Menggunakan clientId dari konfigurasi global
                'client-secret': clientSecret // Menggunakan clientSecret dari konfigurasi global
            }
        });

        const linkquStatus = response.data;
        const statusAPI = linkquStatus.status || linkquStatus.status_code; // Status '00' = Success

        // Logika untuk memperbarui status di database jika LinkQu mengonfirmasi SUKSES
        if (linkquStatus.status_code === '00' || linkquStatus.status === 'SUKSES') {
            const methodCode = orderData.payment_code;
            const table = methodCode === 'QRIS' ? 'inquiry_qris' : 'inquiry_va';

            // Hanya update jika status di DB saat ini masih PENDING
            if (orderData.order_status === 'PENDING_PAYMENT') {
                // Perbarui status di tabel inquiry (VA/QRIS) dan order_service
                await db.execute(`UPDATE ${table} SET status = 'SUKSES', updated_at = NOW() WHERE partner_reff = ?`, [partner_reff]);
                await db.execute(`UPDATE order_service SET order_status = 'PAID', updated_at = NOW() WHERE order_reff = ?`, [partner_reff]);


            }
        }

        // Kembalikan respons dari LinkQu ke frontend
        res.json({
            partner_reff: partner_reff,
            linkqu_response: linkquStatus,
            // Status yang lebih user-friendly untuk frontend
            current_status: (linkquStatus.status_code === '00' || linkquStatus.status === 'SUKSES') ? 'PAID' : 'PENDING'
        });

    } catch (err) {
        // Tangani error jika API LinkQu gagal dihubungi
        logToFile(`❌ Check Status API Error for ${partner_reff}: ${err.message}`);
        res.status(500).json({ error: "Failed to check status with LinkQu API", detail: err.message });
    }
});

app.get('/va-list', async (req, res) => {
    const { username } = req.query;
    try {
        await db.query(`DELETE FROM inquiry_va WHERE status = 'PENDING' AND created_at < NOW() - INTERVAL 1 DAY`);
        const [results] = await db.query(`SELECT bank_name, va_number, amount, status, partner_reff, expired, created_at FROM inquiry_va WHERE customer_id = ? OR partner_reff IN (SELECT order_reff FROM order_service WHERE customer_name = ?) ORDER BY created_at DESC LIMIT 5`, [username, username]);
        res.json(results);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/qr-list', async (req, res) => {
    const { username } = req.query;
    try {
        await db.query(`DELETE FROM inquiry_qris WHERE status = 'PENDING' AND created_at < NOW() - INTERVAL 1 DAY`);
        const [results] = await db.query(`SELECT partner_reff, amount, status, qris_url, expired, created_at FROM inquiry_qris WHERE customer_id = ? OR partner_reff IN (SELECT order_reff FROM order_service WHERE customer_name = ?) ORDER BY created_at DESC LIMIT 5`, [username, username]);
        res.json(results);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/transaction-history', async (req, res) => {
    const { email } = req.query;

    // Validasi input email
    if (!email) {
        return res.status(400).json({ error: "Email is required" });
    }

    try {
        // Query database dengan JOIN untuk mengambil data VA dan QRIS sekaligus
        // ORDER BY created_at DESC memastikan riwayat terbaru ada di posisi paling atas
        const [orders] = await db.query(`
            SELECT 
                os.*, 
                va.va_number, 
                va.bank_name, 
                va.expired as va_expired,
                qr.qris_url, 
                qr.expired as qr_expired
            FROM order_service os
            LEFT JOIN inquiry_va va ON os.order_reff = va.partner_reff
            LEFT JOIN inquiry_qris qr ON os.order_reff = qr.partner_reff
            WHERE os.customer_email = ?
            ORDER BY os.created_at DESC
        `, [email]);

        // Ambil waktu sekarang dalam format LinkQu (YYYYMMDDHHmmss) untuk cek expired
        const nowFormatted = moment().tz('Asia/Jakarta').format('YYYYMMDDHHmmss');

        const history = orders.map(order => {
            let status = order.order_status;
            const expiration = order.va_expired || order.qr_expired;

            // Logika Penentuan Status EXPIRED secara real-time
            // Jika di DB masih PENDING tapi waktu sekarang sudah melewati batas bayar LinkQu
            if (status === 'PENDING' && expiration && nowFormatted > expiration) {
                status = 'EXPIRED'; // Anda bisa mengubah tampilan di frontend berdasarkan label ini
            }

            // Gabungkan rincian data untuk dikirim ke Frontend
            return {
                ...order,
                // Status yang sudah diproses logika expired
                order_status: status,

                // Format mata uang Rupiah yang rapi
                formatted_amount: new Intl.NumberFormat('id-ID', {
                    style: 'currency',
                    currency: 'IDR',
                    minimumFractionDigits: 0
                }).format(order.total_amount),

                // FIX TANGGAL PESAN (Created At): 
                // Paksa menggunakan timezone Asia/Jakarta agar tidak selisih 7 jam dengan UTC
                date_label: moment(order.created_at).tz('Asia/Jakarta').format('DD MMM YYYY, HH:mm'),

                // FIX TANGGAL JADWAL (Schedule Date):
                // Mengonversi tipe data DATE database menjadi string yang cantik
                formatted_schedule: moment(order.schedule_date).format('DD MMM YYYY'),

                // PARSING JASA TAMBAHAN (JSON parsing):
                // Karena di DB tipenya LongText/String, kita ubah kembali jadi Array agar frontend bisa looping
                extra_services_list: order.extra_services ? JSON.parse(order.extra_services) : [],

                // Tambahan: Informasi kadaluarsa dalam format yang bisa dibaca manusia
                formatted_expiration: expiration ? moment(expiration, "YYYYMMDDHHmmss").format('DD MMM, HH:mm') : '-'
            };
        });

        // Kirim data riwayat ke Client
        res.json(history);

    } catch (err) {
        console.error("❌ Error fetch history:", err.message);
        res.status(500).json({
            error: "Gagal mengambil data riwayat",
            message: err.message
        });
    }
});

const PORT = 3000;
app.listen(PORT, () => console.log(`🚀 Server TangerangFast running on http://localhost:${PORT}`));