// index.js (create-order function)
const Razorpay = require('razorpay');
const sdk = require('node-appwrite');

module.exports = async function (req, res) {
    try {
        // incoming payload is a JSON string in req.payload (Appwrite function)
        const payload = req.payload ? JSON.parse(req.payload) : {};
        const { amount /* rupees */, currency = 'INR', receipt, userId, items } = payload;

        if (!amount || !userId) {
            return res.json({ success: false, message: 'amount and userId required' }, 400);
        }

        // Initialize Razorpay
        const razorpay = new Razorpay({
            key_id: rzp_test_RH8HdkZbA9xnoK,
            key_secret: V2OIX2UM8B6CGlxk0UjzQmk1,
        });

        // Razorpay requires amount in paise
        const amountPaise = Math.round(amount * 100);

        const orderOptions = {
            amount: amountPaise,
            currency,
            receipt: receipt || `rcpt_${Date.now()}`,
            payment_capture: 1, // 1 to auto-capture
        };

        // create razorpay order
        const razorOrder = await razorpay.orders.create(orderOptions);

        // Initialize Appwrite client (use function API key set in env)
        const client = new sdk.Client()
            .setEndpoint(process.env.APPWRITE_FUNCTION_ENDPOINT || process.env.APPWRITE_ENDPOINT)
            .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID || process.env.APPWRITE_PROJECT_ID)
            .setKey(process.env.APPWRITE_FUNCTION_API_KEY || process.env.APPWRITE_API_KEY);

        const databases = new sdk.Databases(client);

        // create an orders document in Appwrite
        const orderDoc = await databases.createDocument(
            process.env.APPWRITE_DATABASE_ID,
            process.env.APPWRITE_ORDERS_COLLECTION_ID,
            sdk.ID.unique(),
            {
                userId,
                items: items || [],
                amount,
                currency,
                receipt: orderOptions.receipt,
                razorpay_order_id: razorOrder.id,
                status: 'created',
                createdAt: new Date().toISOString(),
            }
        );

        // Return razorpay order and local order id to client
        return res.json({ success: true, razorOrder, localOrderId: orderDoc.$id });
    } catch (err) {
        console.error('create-order error', err);
        return res.json({ success: false, message: err.message || err.toString() }, 500);
    }
};
