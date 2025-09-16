// snippet to replace the section where you prepare safeItems and createDocument
// (apply inside your createOrder_debug or production function)

/* --- normalize items into safeItems (unchanged) --- */
let safeItems = [];
if (Array.isArray(items)) safeItems = items;
else if (typeof items === "string") {
    try { safeItems = JSON.parse(items); } catch { safeItems = []; }
} else if (items && typeof items === "object") {
    safeItems = [items];
} else {
    safeItems = [];
}

log("📦 safeItems that will be saved (DEBUG):", JSON.stringify(safeItems).slice(0, 1000));

/* --- Convert safeItems into Appwrite-friendly string array --- */
const MAX_ATTR_LEN = 499;
const itemsStrings = safeItems.map((it, idx) => {
    // prefer a short human summary
    try {
        // prefer compact stringify
        const short = JSON.stringify(it);
        if (short.length <= MAX_ATTR_LEN) return short;
        // fallback to a compact summary (name + qty + productId)
        const summary = `${it.name || it.productId || "item"}|q:${it.quantity ?? 1}|id:${it.productId ?? ""}`;
        if (summary.length <= MAX_ATTR_LEN) return summary;
        // final fallback: truncate JSON
        return short.slice(0, MAX_ATTR_LEN - 3) + "...";
    } catch (e) {
        const fallback = String(it).slice(0, MAX_ATTR_LEN - 3) + "...";
        return fallback;
    }
});

/* --- log if any truncation occurred so you can audit --- */
itemsStrings.forEach((s, i) => {
    if (s.length > MAX_ATTR_LEN - 3) {
        log(`⚠️ itemsStrings[${i}] was truncated to ${s.length} chars.`);
    }
});

/* --- Persist to DB (await for debugging) --- */
try {
    const created = await databases.createDocument(
        "68c414290032f31187eb",
        "68c58bfe0001e9581bd4",
        ID.unique(),
        {
            userId,
            amount: intAmount,
            amountPaise: order.amount,
            currency: order.currency,
            razorpay_order_id: order.id,
            razorpay_payment_id: null,
            razorpay_signature: null,
            status: "unpaid",
            receipt: order.receipt,
            // store Appwrite-compatible string array
            items: itemsStrings,
            // keep full JSON backup
            items_json: JSON.stringify(safeItems),
            verification_raw: null,
        }
    );

    log("✅ Order saved in DB (DEBUG). Document ID:", created.$id);
    return res.json({
        success: true,
        orderId: order.id,
        amount: order.amount,
        currency: order.currency,
        savedDocument: created,
    });
} catch (dbErr) {
    error("❌ DB save failed (DEBUG): " + (dbErr.message || dbErr));
    return res.json({
        success: false,
        message: "Order created in Razorpay but failed to save in DB",
        order: { id: order.id, amount: order.amount, currency: order.currency },
        dbError: (dbErr.message || String(dbErr)),
    }, 500);
}
