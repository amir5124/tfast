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
const authToken =  process.env.TWILIO_ACCOUNT_TOKEN;
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
            from: 'linkutransport@gmail.com',
            to: to,
            subject: subject,
            html: htmlContent,
        });
        return { status: true };
    } catch (error) {
        logToFile(`❌ Gagal kirim email ke ${to}: ${error.message}`);
        if (to !== ADMIN_EMAIL) {
            await transporter.sendMail({
                from: 'linkutransport@gmail.com',
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

async function sendWhatsAppCustomerSuccess(to, variables) {
    const formattedTo = formatToWhatsAppNumber(to);
    try {
        const response = await twilioClient.messages.create({
            from: twilioFrom,
            to: `whatsapp:${formattedTo}`,
            contentSid: 'HX83d2f6ce8fa5693a942935bb0f44a77d', // Gunakan Content SID template 7 variabel Anda
            contentVariables: JSON.stringify(variables),
        });
        return { status: true, sid: response.sid };
    } catch (error) {
        logToFile(`❌ Gagal WA Customer ${formattedTo}: ${error.message}`);
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

async function getCurrentStatusVa(partnerReff) {
    const [rows] = await db.execute('SELECT status FROM inquiry_va WHERE partner_reff = ?', [partnerReff]);
    return rows.length > 0 ? rows[0].status : null;
}

async function getCurrentStatusQris(partnerReff) {
    const [rows] = await db.execute('SELECT status FROM inquiry_qris WHERE partner_reff = ?', [partnerReff]);
    return rows.length > 0 ? rows[0].status : null;
}

// ------------------------------------
// ⚡ ENDPOINTS
// ------------------------------------

app.post('/create-va', async (req, res) => {
    try {
        const body = req.body;
        const partner_reff = generatePartnerReff();
        const expired = getExpiredTimestamp();
        const orderServiceId = await insertOrderService(body, partner_reff);
        const orderData = await getOrderDetails(partner_reff);

        const signature = generateSignaturePOST({
            amount: body.totalBayar, expired, bank_code: body.metodePembayaran.code, 
            partner_reff, customer_id: body.kontak.nama, customer_name: body.kontak.nama, 
            customer_email: body.kontak.email, clientId
        }, '/transaction/create/va');

        const response = await axios.post('https://api.linkqu.id/linkqu-partner/transaction/create/va', {
            amount: body.totalBayar, bank_code: body.metodePembayaran.code, partner_reff,
            username, pin, expired, signature, customer_id: body.kontak.nama,
            customer_name: body.kontak.nama, customer_email: body.kontak.email, url_callback: "https://layanan.tangerangfast.online/callback"
        }, { headers: { 'client-id': clientId, 'client-secret': clientSecret } });

        const result = response.data;
        await db.query('INSERT INTO inquiry_va SET ?', [{
            order_service_id: orderServiceId, partner_reff, customer_id: body.kontak.nama,
            amount: body.totalBayar, bank_name: result?.bank_name || body.metodePembayaran.name,
            expired, va_number: result?.virtual_account, response_raw: JSON.stringify(result),
            created_at: new Date(), status: "PENDING"
        }]);

        // Email Invoice
        const emailHTML = `<html><body><h2>TAGIHAN #${partner_reff}</h2><p>Layanan: ${body.layanan.nama}</p><p>Total: ${formatIDR(body.totalBayar)}</p><p>VA: ${result?.virtual_account}</p></body></html>`;
        await sendEmailNotification(body.kontak.email, `Tagihan #${partner_reff}`, emailHTML);
        
        res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/create-qris', async (req, res) => {
    try {
        const body = req.body;
        const partner_reff = generatePartnerReff();
        const expired = getExpiredTimestamp();
        const orderServiceId = await insertOrderService(body, partner_reff);
        const orderData = await getOrderDetails(partner_reff);

        const signature = generateSignaturePOST({
            amount: body.totalBayar, expired, partner_reff, customer_id: body.kontak.nama,
            customer_name: body.kontak.nama, customer_email: body.kontak.email, clientId
        }, '/transaction/create/qris');

        const response = await axios.post('https://api.linkqu.id/linkqu-partner/transaction/create/qris', {
            amount: body.totalBayar, partner_reff, username, pin, expired, signature,
            customer_id: body.kontak.nama, customer_name: body.kontak.nama, 
            customer_email: body.kontak.email, url_callback: "https://layanan.tangerangfast.online/callback"
        }, { headers: { 'client-id': clientId, 'client-secret': clientSecret } });

        const result = response.data;
        await db.execute(`INSERT INTO inquiry_qris (order_service_id, partner_reff, customer_id, amount, expired, qris_url, response_raw, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), 'PENDING')`,
            [orderServiceId, partner_reff, body.kontak.nama, body.totalBayar, expired, result?.imageqris, JSON.stringify(result)]);

        const emailHTML = `<html><body><h2>TAGIHAN #${partner_reff}</h2><p>Total: ${formatIDR(body.totalBayar)}</p><p>Scan QRIS: <a href="${result?.imageqris}">Klik Di Sini</a></p></body></html>`;
        await sendEmailNotification(body.kontak.email, `Tagihan #${partner_reff}`, emailHTML);

        res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/callback', async (req, res) => {
    const { partner_reff, va_code } = req.body;
    
    try {
        // 1. Ambil data order dari database
        const orderData = await getOrderDetails(partner_reff);
        if (!orderData) return res.status(404).json({ error: "Order Not Found" });

        // Cegah proses ganda jika sudah lunas
        if (orderData.order_status === 'PAID') return res.json({ message: "Done" });

        const methodType = va_code === 'QRIS' ? 'QRIS' : 'VA';
        const table = methodType === 'QRIS' ? 'inquiry_qris' : 'inquiry_va';

        // 2. Update Database (Lunas)
        await db.execute(
            `UPDATE ${table} SET status = 'SUKSES', callback_raw = ?, updated_at = NOW() WHERE partner_reff = ?`, 
            [JSON.stringify(req.body), partner_reff]
        );
        await db.execute(
            `UPDATE order_service SET order_status = 'PAID', updated_at = NOW() WHERE order_reff = ?`, 
            [partner_reff]
        );

        // 3. Siapkan Variabel Notifikasi
        const totalFormatted = formatIDR(orderData.total_amount);
        let detailJasa = "-";
        if (orderData.extra_services) {
            try {
                const extras = JSON.parse(orderData.extra_services);
                detailJasa = extras.map(i => i.nama).join(', ');
            } catch (e) { detailJasa = "-"; }
        }

        // 4. KIRIM NOTIFIKASI JAGEL (Paling Stabil)
        try {
            await axios.post('https://api.jagel.id/v1/message/send', {
                apikey: "z4PBduE9ocedWaaTUCKHnOl7C8yokkTB4catk7FMt5U2d4Lmyv", 
                type: 'email', 
                value: orderData.customer_email || ADMIN_EMAIL,
                content: `✅ *PEMBAYARAN BERHASIL!*\n\nInv: *${partner_reff}*\nLayanan: ${orderData.service_name}\nTotal: ${totalFormatted}`
            });
        } catch (e) { logToFile(`Jagel Error: ${e.message}`); }

        // 5. KIRIM WA CUSTOMER (Twilio)
        await sendWhatsAppCustomerSuccess(orderData.customer_phone, {
            1: orderData.customer_name,
            2: partner_reff,
            3: orderData.service_name,
            4: detailJasa,
            5: orderData.schedule_date,
            6: orderData.schedule_time,
            7: totalFormatted
        });

        // 6. KIRIM EMAIL DETAIL
        const emailHtml = `
            <div style="font-family:sans-serif; padding:20px; border:1px solid #ddd; border-radius:10px;">
                <h2 style="color:#27ae60;">Pembayaran Diterima!</h2>
                <p>Pesanan <b>#${partner_reff}</b> telah lunas.</p>
                <hr>
                <p><b>Detail Layanan:</b> ${orderData.service_name}</p>
                <p><b>Jadwal:</b> ${orderData.schedule_date} ${orderData.schedule_time}</p>
                <p><b>Total:</b> ${totalFormatted}</p>
            </div>`;
        await sendEmailNotification(orderData.customer_email, `Lunas #${partner_reff}`, emailHtml);

        res.json({ message: "OK" });

    } catch (err) {
        logToFile(`❌ Callback Error: ${err.message}`);
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
    if (!email) return res.status(400).json({ error: "Email is required" });

    try {
        const [orders] = await db.query(`
            SELECT 
                os.order_reff, os.service_name, os.total_amount, os.order_status, os.created_at, os.payment_method,
                va.va_number, va.bank_name, va.expired as va_expired,
                qr.qris_url, qr.expired as qr_expired
            FROM order_service os
            LEFT JOIN inquiry_va va ON os.order_reff = va.partner_reff
            LEFT JOIN inquiry_qris qr ON os.order_reff = qr.partner_reff
            WHERE os.customer_email = ?
            ORDER BY os.created_at DESC
        `, [email]);

        const now = moment().tz('Asia/Jakarta').format('YYYYMMDDHHmmss');

        const history = orders.map(order => {
            let status = order.order_status;
            const expiration = order.va_expired || order.qr_expired;

            // Logika Status Gagal jika Expired
            if (status === 'PENDING_PAYMENT' && expiration && now > expiration) {
                status = 'EXPIRED';
            }

            return {
                ...order,
                order_status: status,
                formatted_amount: formatIDR(order.total_amount),
                date_label: moment(order.created_at).format('DD MMM YYYY, HH:mm')
            };
        });

        res.json(history);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = 3000;
app.listen(PORT, () => console.log(`🚀 Server TangerangFast running on http://localhost:${PORT}`));