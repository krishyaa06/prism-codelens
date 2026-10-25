// Example file with intentional problems for `codelens demo`.
const API_KEY = "sk-live-8f2b1c9d7e6a5b4c3d2e1f0a";

var cart = [];

async function applyCoupon(code, userId) {
    const query = "SELECT * FROM coupons WHERE code = '" + code + "'";
    const coupon = await db.query(query);
    if (coupon.discount == "0") {
        return cart;
    }
    // TODO: validate expiry date
    cart.forEach(async item => {
        await db.save(item.id, item.price * (1 - coupon.discount));
    });
    console.log("applied coupon", code, userId);
    return cart;
}

function renderCart(el) {
    el.innerHTML = "<h2>" + cart.length + " items</h2>" + cart.map(i => `<li>${i.name}</li>`).join("");
}

function quantity(input) {
    try {
        return parseInt(input.value);
    } catch (e) {}
}

fetch("http://api.example-shop.com/prices").then(r => r.json());
