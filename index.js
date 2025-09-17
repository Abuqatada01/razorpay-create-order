import express from "express";
import Razorpay from "razorpay";
import { Client, Databases, ID } from "node-appwrite";

const app = express();
app.use(express.json());

// Initialize Razorpay
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Initialize Appwrite
const client = new Client()
    .setEndpoint(process.env.APPWRITE_ENDPOINT)
    .setProject(process.env.APPWRITE_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY);

const databases = new Databases(client);

app.post("/create-order", async (req, res) => {
    try {
        const { amount, currency, userId, shipping, items } = req.body;

        if (!amount || !userId) {
            return res.status(400).json({
                success: false,
                message: "amount and userId required",
            });
        }

        // 1. Create Razorpay order
        const options = {
            amount: amount * 100, // Razorpay expects paise
            currency: currency || "INR",
            receipt: `receipt_${Date.now()}`,
        };

        const order = await razorpay.orders.create(options);

        // 2. Prepare data for Appwrite
        const shippingArray = Array.isArray(shipping) ? shipping : [shipping];
        const shipping_first = shippingArray[0] || {};

        const shipping_short = `${shipping_first.full_name || ""}, ${shipping_first.line_1 || ""}, ${shipping_first.city || ""}`;

        const items_short = (items || []).map(
            (item) => `${item.name} x ${item.quantity}`
        );

        // 3. Build payload matching Appwrite schema
        const payload = {
            userId,
            productId: items?.map((i) => i.productId).join(", "),
            productName: items?.map((i) => i.name).join(", "),
            amount,
            paymentId: "",
            orderId: order.id,
            status: "unpaid",
            date: new Date().toISOString(),

            // Flattened shipping fields
            shipping_full_name: shipping_first.full_name || "",
            shipping_phone: shipping_first.phone || "",
            shipping_line_1: shipping_first.line_1 || "",
            //   shipping_line_2: shipping_first.line_2 || "",
            shipping_city: shipping_first.city || "",
            shipping_state: shipping_first.state || "",
            shipping_country: shipping_first.country || "",
            shipping_postal_code: shipping_first.postal_code || "",

            // Schema expects strings:
            shipping: shipping_short, // ✅ short string version
            items: JSON.stringify(items_short).slice(0, 9999), // ✅ stringified summary
            items_json: JSON.stringify(items || []).slice(0, 999), // ✅ stringified full items
        };

        // 4. Save order in Appwrite
        const savedOrder = await databases.createDocument(
            process.env.APPWRITE_DATABASE_ID,
            process.env.APPWRITE_ORDERS_COLLECTION_ID,
            ID.unique(),
            payload
        );

        // 5. Send response
        res.json({
            success: true,
            order,
            appwriteOrder: savedOrder,
        });
    } catch (error) {
        console.error("Error creating order:", error);
        res.status(500).json({
            success: false,
            message: "Server error",
            error: error.message,
        });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
