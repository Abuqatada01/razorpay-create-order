// create-order.js
import Razorpay from "razorpay";
import { Client, Databases, ID } from "node-appwrite";

export default async ({ req, res, log, error }) => {
    try {
        const { amount, userId, productName } = JSON.parse(req.body);

        // Razorpay instance
        const razorpay = new Razorpay({
            key_id: "rzp_test_RH8HdkZbA9xnoK",
            key_secret: "V2OIX2UM8B6CGlxk0UjzQmk1",
        });

        // Create order
        const order = await razorpay.orders.create({
            amount: amount * 100, // in paise
            currency: "INR",
        });

        // Connect to Appwrite
        const client = new Client()
            .setEndpoint("https://fra.cloud.appwrite.io/v1")
            .setProject("684c05fe002863accd73")
            .setKey("standard_62d893d06bb23cce71d8bdb735be5e2f7b1a98e3d0927e78f52b1abfce08d2adbd47b712c335638fb59bf94b748b62184e577c115a2caf53b2342e779dd188fa39f3c3d105e409e6554a3c2b6341dc87728ff60a4ff540d350e3bb181d313dbae8f8de3a994ab753095e4d2b18fe57b033f7234acbdcbe2ba630c155d06b9558");

        const databases = new Databases(client);

        // Save to DB
        await databases.createDocument(
            "68c414290032f31187eb",
            "68c8567e001a18aefff0",
            order.id, // use Razorpay order_id as docId
            {
                userId,
                productName,
                amount,
                status: "unpaid",
                date: new Date(),
            }
        );

        return res.json({ success: true, order });
    } catch (err) {
        error(err.message);
        return res.json({ success: false, error: err.message }, 500);
    }
};
