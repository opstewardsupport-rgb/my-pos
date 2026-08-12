notify("Business name updated.");
      return true;
    } catch (err) {
      notify(err.message || "Couldn't update setting.", "err");
      return false;
    }
  }, [authUser, notify]);

  // Once the owner has paid via PayMongo, this marks their subscription active
  // in Supabase using the payment reference they entered (or "PAID" if none).
  const markSubscriptionActive = useCallback(async (reference = "PAID") => {
    if (!authUser) return false;
    const { error } = await supabase
      .from("businesses")
      .update({ subscription_status: "active", payment_reference: reference })
      .eq("id", authUser.id);
    if (error) {
      notify("Couldn't activate subscription: " + error.message, "err");
      return false;
    }
    const next = { ...(accountRef.current || {}), subscriptionStatus: "active", paymentReference: reference };
    accountRef.current = next;
    setAccount(next);
    setShowUpgrade(false);
    notify("Thank you! Your subscription is now active.");
    return true;
  }, [authUser, notify]);

  const recordSale = useCallback(async (newSale) => {
    const nextSal = [newSale, ...sales];
    const purged = purgeOldSales(nextSal);
    setSales(purged);
    await safeSet(SALES_KEY, purged);
    const nextNo = nextOrderNo + 1;
    setNextOrderNo(nextNo);
    await safeSet(ORDER_COUNTER_KEY, nextNo);
  }, [sales, nextOrderNo]);

  const addProduct = async (prod) => {
    const next = { ...catalog, products: [prod, ...catalog.products] };
    setCatalog(next);
    await safeSet(CATALOG_KEY, next);
    notify("Product added");
  };

  const updateProduct = async (prod) => {
    const next = {
      ...catalog,
      products: catalog.products.map((p) => (p.id === prod.id ? prod : p)),
    };
    setCatalog(next);
    await safeSet(CATALOG_KEY, next);
    notify("Product updated");
  };

  const deleteProduct = async (id) => {
    const next = {
      ...catalog,
      products: catalog.products.filter((p) => p.id !== id),
    };
    setCatalog(next);
    await safeSet(CATALOG_KEY, next);
    notify("Product deleted");
  };

  const addIngredient = async (ing) => {
    const next = { ...catalog, ingredients: [ing, ...catalog.ingredients] };
    setCatalog(next);
    await safeSet(CATALOG_KEY, next);
    notify("Ingredient added");
  };

  const updateIngredient = async (ing) => {
    const next = {
      ...catalog,
      ingredients: catalog.ingredients.map((i) => (i.id === ing.id ? ing : i)),
    };
    setCatalog(next);
    await safeSet(CATALOG_KEY, next);
    notify("Ingredient updated");
  };

  const deleteIngredient = async (id) => {
    const next = {
      ...catalog,
      ingredients: catalog.ingredients.filter((i) => i.id !== id),
    };
    setCatalog(next);
    await safeSet(CATALOG_KEY, next);
    notify("Ingredient deleted");
  };

  const addCategory = async (name) => {
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    if (catalog.categories.some((c) => c.id === id)) {
      notify("Category already exists", "err");
      return;
    }
    const next = {
      ...catalog,
      categories: [...catalog.categories, { id, name }],
    };
    setCatalog(next);
    await safeSet(CATALOG_KEY, next);
    notify("Category added");
  };

  const addToCart = (prod) => {
    setCart((prev) => {
      const idx = prev.findIndex((i) => i.productId === prod.id);
      if (idx >= 0) {
        const copy = [...prev];
        copy[idx] = { ...copy[idx], qty: copy[idx].qty + 1 };
        return copy;
      }
      return [...prev, { productId: prod.id, qty: 1 }];
    });
  };

  const updateCartQty = (productId, delta) => {
    setCart((prev) => {
      return prev
        .map((item) => {
          if (item.productId !== productId) return item;
          const nextQty = item.qty + delta;
          return nextQty > 0 ? { ...item, qty: nextQty } : null;
        })
        .filter(Boolean);
    });
  };

  // Prepares the items list, subtotal, discount, total, and ingredient deductions
  // for checkout. Shared by `checkout` and the split-payment sub-checkouts so
  // there's no math duplication.
  const computeCheckoutSummary = useCallback(() => {
    const items = cart
      .map((ci) => {
        const p = catalog.products.find((x) => x.id === ci.productId);
        if (!p) return null;
        return {
          productId: p.id,
          name: p.name,
          price: p.price,
          qty: ci.qty,
          subtotal: p.price * ci.qty,
          voided: false,
        };
      })
      .filter(Boolean);

    const subtotal = items.reduce((s, i) => s + i.subtotal, 0);

    let discountAmount = 0;
    const val = Number(discountValue) || 0;
    if (discountType === "percent") {
      discountAmount = (subtotal * Math.min(100, Math.max(0, val))) / 100;
    } else if (discountType === "amount") {
      discountAmount = Math.min(subtotal, Math.max(0, val));
    }
    const total = Math.max(0, subtotal - discountAmount);

    return { items, subtotal, discountAmount, total };
  }, [cart, catalog.products, discountType, discountValue]);

  const checkout = async () => {
    if (cart.length === 0) return;
    setCheckoutError(null);

    const { items, subtotal, discountAmount, total } = computeCheckoutSummary();

    let change = 0;
    const cashNum = Number(cashReceived) || 0;
    if (paymentMethod === "cash") {
      if (cashNum < total) {
        setCheckoutError(`Cash received (${money(cashNum)}) is less than total (${money(total)})`);
        return;
      }
      change = cashNum - total;
    }

    // Check inventory stock and deduct
    const ings = [...catalog.ingredients];
    const deductionMap = {};
    for (const ci of cart) {
      const prod = catalog.products.find((p) => p.id === ci.productId);
      if (!prod || !prod.recipe) continue;
      for (const r of prod.recipe) {
        const needed = r.amount * ci.qty;
        deductionMap[r.ingredientId] = (deductionMap[r.ingredientId] || 0) + needed;
      }
    }

    for (const [ingId, needed] of Object.entries(deductionMap)) {
      const ing = ings.find((i) => i.id === ingId);
      if (!ing) continue;
      if (ing.stock < needed) {
        setCheckoutError(`Not enough stock for "${ing.name}". Needed: ${needed} ${ing.unit}, available: ${ing.stock} ${ing.unit}`);
        return;
      }
    }

    // Perform deduction
    const nextIngs = ings.map((ing) => {
      const needed = deductionMap[ing.id];
      if (needed) {
        return { ...ing, stock: Math.max(0, ing.stock - needed) };
      }
      return ing;
    });

    const nextCatalog = { ...catalog, ingredients: nextIngs };
    setCatalog(nextCatalog);
    await safeSet(CATALOG_KEY, nextCatalog);

    const emp = employees.find((e) => e.id === currentEmployeeId);
    const newSale = {
      id: uid("sale"),
      orderNo: nextOrderNo,
      timestamp: Date.now(),
      items,
      subtotal,
      discountAmount,
      total,
      paymentMethod,
      cashReceived: paymentMethod === "cash" ? cashNum : total,
      change,
      paymentProof,
      employeeId: currentEmployeeId,
      employeeName: emp ? emp.name : "Staff",
      voided: false,
    };

    await recordSale(newSale);
    setReceipt(newSale);
    setCart([]);
    setCashReceived("");
    setDiscountType("none");
    setDiscountValue("");
    setPaymentProof(null);
    notify(`Order #${nextOrderNo} completed successfully!`);
  };

  const checkoutSplit = async () => {
    if (cart.length === 0) return;
    setCheckoutError(null);

    const { items, subtotal, discountAmount, total } = computeCheckoutSummary();

    // Validate split legs sum up to total
    let finalLegs = [];
    if (splitMode === "amount") {
      const legAmounts = splitPayments.map((p, idx) => {
        if (idx === splitPayments.length - 1) {
          // Last leg automatically takes remainder so we never fail due to rounding
          const sumOthers = splitPayments.slice(0, -1).reduce((s, x) => s + (Number(x.amount) || 0), 0);
          return Math.max(0, Number((total - sumOthers).toFixed(2)));
        }
        return Number(p.amount) || 0;
      });
      const sumLegs = legAmounts.reduce((s, a) => s + a, 0);
      if (Math.abs(sumLegs - total) > 0.02) {
        setCheckoutError(`Split payments total (${money(sumLegs)}) must equal cart total (${money(total)})`);
        return;
      }
      finalLegs = splitPayments.map((p, idx) => ({ method: p.method, amount: legAmounts[idx] }));
    } else {
      // items mode: group cart items by selected leg
      const legMap = {}; // legIdx -> total amount
      for (const ci of cart) {
        const p = catalog.products.find((x) => x.id === ci.productId);
        if (!p) continue;
        const legIdx = splitItemLegs[ci.productId] ?? 0;
        legMap[legIdx] = (legMap[legIdx] || 0) + p.price * ci.qty;
      }
      finalLegs = Object.entries(legMap).map(([idx, amt]) => ({
        method: splitPayments[Number(idx)]?.method || "cash",
        amount: Number(amt.toFixed(2)),
      }));
      const sumLegs = finalLegs.reduce((s, l) => s + l.amount, 0);
      if (Math.abs(sumLegs - total) > 0.02) {
        setCheckoutError(`Assigned item payments (${money(sumLegs)}) must equal total (${money(total)})`);
        return;
      }
    }

    // Deduct stock (same as regular checkout)
    const ings = [...catalog.ingredients];
    const deductionMap = {};
    for (const ci of cart) {
      const prod = catalog.products.find((p) => p.id === ci.productId);
      if (!prod || !prod.recipe) continue;
      for (const r of prod.recipe) {
        const needed = r.amount * ci.qty;
        deductionMap[r.ingredientId] = (deductionMap[r.ingredientId] || 0) + needed;
      }
    }

    for (const [ingId, needed] of Object.entries(deductionMap)) {
      const ing = ings.find((i) => i.id === ingId);
      if (!ing) continue;
      if (ing.stock < needed) {
        setCheckoutError(`Not enough stock for "${ing.name}". Needed: ${needed} ${ing.unit}, available: ${ing.stock} ${ing.unit}`);
        return;
      }
    }

    const nextIngs = ings.map((ing) => {
      const needed = deductionMap[ing.id];
      if (needed) {
        return { ...ing, stock: Math.max(0, ing.stock - needed) };
      }
      return ing;
    });

    const nextCatalog = { ...catalog, ingredients: nextIngs };
    setCatalog(nextCatalog);
    await safeSet(CATALOG_KEY, nextCatalog);

    const emp = employees.find((e) => e.id === currentEmployeeId);
    const newSale = {
      id: uid("sale"),
      orderNo: nextOrderNo,
      timestamp: Date.now(),
      items,
      subtotal,
      discountAmount,
      total,
      paymentMethod: "split",
      payments: finalLegs,
      cashReceived: total,
      change: 0,
      paymentProof,
      employeeId: currentEmployeeId,
      employeeName: emp ? emp.name : "Staff",
      voided: false,
    };

    await recordSale(newSale);
    setReceipt(newSale);
    setCart([]);
    setCashReceived("");
    setDiscountType("none");
    setDiscountValue("");
    setPaymentProof(null);
    notify(`Order #${nextOrderNo} (Split Payment) completed!`);
  };

  const handleFileUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setProofProcessing(true);
    try {
      const dataUrl = await fileToResizedDataURL(file, 480, 0.72);
      setPaymentProof(dataUrl);
      notify("Payment proof attached");
    } catch {
      notify("Couldn't attach image — please try another file.", "err");
    } finally {
      setProofProcessing(false);
    }
  };

  const voidSale = async (saleId, reason) => {
    const target = sales.find((s) => s.id === saleId);
    if (!target) return;
    if (target.voided) {
      notify("Sale is already voided", "err");
      return;
    }

    // Return ingredients to stock
    const ings = [...catalog.ingredients];
    const returnMap = {};
    for (const item of target.items) {
      if (itemIsVoided(target, item)) continue;
      const prod = catalog.products.find((p) => p.id === item.productId);
      if (!prod || !prod.recipe) continue;
      for (const r of prod.recipe) {
        returnMap[r.ingredientId] = (returnMap[r.ingredientId] || 0) + r.amount * item.qty;
      }
    }

    const nextIngs = ings.map((ing) => {
      const added = returnMap[ing.id];
      if (added) return { ...ing, stock: ing.stock + added };
      return ing;
    });

    const nextCatalog = { ...catalog, ingredients: nextIngs };
    setCatalog(nextCatalog);
    await safeSet(CATALOG_KEY, nextCatalog);

    const nextSales = sales.map((s) =>
      s.id === saleId ? { ...s, voided: true, voidReason: reason, voidTimestamp: Date.now() } : s
    );
    setSales(nextSales);
    await safeSet(SALES_KEY, nextSales);
    setVoidModal(null);
    notify(`Order #${target.orderNo} voided and stock restored.`);
  };

  // Manager-authorized restoration of a voided sale (e.g. voided by mistake)
  const restoreVoidedSale = async (saleId, managerPin) => {
    const mgr = employees.find((e) => e.role === "manager" && e.pin === managerPin);
    if (!mgr) {
      notify("Invalid manager PIN", "err");
      return;
    }
    const target = sales.find((s) => s.id === saleId);
    if (!target || !target.voided) {
      notify("Sale is not voided", "err");
      return;
    }

    // Re-deduct stock
    const ings = [...catalog.ingredients];
    const deductionMap = {};
    for (const item of target.items) {
      const prod = catalog.products.find((p) => p.id === item.productId);
      if (!prod || !prod.recipe) continue;
      for (const r of prod.recipe) {
        deductionMap[r.ingredientId] = (deductionMap[r.ingredientId] || 0) + r.amount * item.qty;
      }
    }

    for (const [ingId, needed] of Object.entries(deductionMap)) {
      const ing = ings.find((i) => i.id === ingId);
      if (!ing || ing.stock < needed) {
        notify(`Cannot restore: Not enough stock for "${ing?.name || 'ingredient'}".`, "err");
        return;
      }
    }

    const nextIngs = ings.map((ing) => {
      const needed = deductionMap[ing.id];
      if (needed) return { ...ing, stock: Math.max(0, ing.stock - needed) };
      return ing;
    });

    const nextCatalog = { ...catalog, ingredients: nextIngs };
    setCatalog(nextCatalog);
    await safeSet(CATALOG_KEY, nextCatalog);

    const nextSales = sales.map((s) =>
      s.id === saleId ? { ...s, voided: false, restoredAt: Date.now(), restoredBy: mgr.name } : s
    );
    setSales(nextSales);
    await safeSet(SALES_KEY, nextSales);
    setRestoreModal(null);
    notify(`Order #${target.orderNo} restored by ${mgr.name}.`);
  };

  // Per-item void: voids a single line item within an active sale without voiding the whole order.
  const voidSaleItem = async (saleId, itemIdx, reason, managerPin) => {
    const mgr = employees.find((e) => e.role === "manager" && e.pin === managerPin);
    if (!mgr) {
      notify("Invalid manager PIN", "err");
      return;
    }
    const target = sales.find((s) => s.id === saleId);
    if (!target || target.voided) {
      notify("Sale not found or already fully voided", "err");
      return;
    }
    const item = target.items[itemIdx];
    if (!item || itemIsVoided(target, item)) {
      notify("Item already voided or invalid", "err");
      return;
    }

    // Return stock for this specific item
    const ings = [...catalog.ingredients];
    const returnMap = {};
    const prod = catalog.products.find((p) => p.id === item.productId);
    if (prod && prod.recipe) {
      for (const r of prod.recipe) {
        returnMap[r.ingredientId] = r.amount * item.qty;
      }
    }

    const nextIngs = ings.map((ing) => {
      const added = returnMap[ing.id];
      if (added) return { ...ing, stock: ing.stock + added };
      return ing;
    });

    const nextCatalog = { ...catalog, ingredients: nextIngs };
    setCatalog(nextCatalog);
    await safeSet(CATALOG_KEY, nextCatalog);

    const updatedItems = target.items.map((it, idx) =>
      idx === itemIdx ? { ...it, voided: true, voidReason: reason, voidedBy: mgr.name } : it
    );
    const newTotal = updatedItems.filter((it) => !it.voided).reduce((s, it) => s + it.subtotal, 0);

    const nextSales = sales.map((s) =>
      s.id === saleId ? { ...s, items: updatedItems, total: Math.max(0, newTotal - (s.discountAmount || 0)) } : s
    );
    setSales(nextSales);
    await safeSet(SALES_KEY, nextSales);
    notify(`Item "${item.name}" voided by ${mgr.name}, stock restored.`);
  };

  const restockIngredient = async (ingId, addAmount) => {
    const qty = Number(addAmount);
    if (!qty || qty <= 0) return;
    const nextIngs = catalog.ingredients.map((i) => (i.id === ingId ? { ...i, stock: i.stock + qty } : i));
    const nextCatalog = { ...catalog, ingredients: nextIngs };
    setCatalog(nextCatalog);
    await safeSet(CATALOG_KEY, nextCatalog);
    setRestockId(null);
    setRestockVal("");
    notify("Stock updated successfully");
  };

  // Employees & PINs
  const addEmployee = async (name, role, pin) => {
    if (!name.trim()) return;
    const next = [...employees, { id: uid("emp"), name: name.trim(), role: role || "staff", pin: pin ? pin.trim() : "" }];
    setEmployees(next);
    await safeSet(EMPLOYEES_KEY, next);
    notify("Employee added");
  };

  const updateEmployee = async (id, name, role, pin) => {
    const next = employees.map((e) => (e.id === id ? { ...e, name: name.trim(), role: role || e.role || "staff", pin: pin !== undefined ? pin.trim() : e.pin } : e));
    setEmployees(next);
    await safeSet(EMPLOYEES_KEY, next);
    notify("Employee updated");
  };

  const deleteEmployee = async (id) => {
    if (employees.length <= 1) {
      notify("You must keep at least one employee.", "err");
      return;
    }
    const next = employees.filter((e) => e.id !== id);
    setEmployees(next);
    await safeSet(EMPLOYEES_KEY, next);
    if (currentEmployeeId === id) {
      setCurrentEmployeeId(next[0].id);
      await safeSet(CURRENT_EMPLOYEE_KEY, next[0].id);
    }
    notify("Employee removed");
  };

  const switchCurrentEmployee = async (id) => {
    const activeShift = shifts.find((s) => !s.closedAt);
    if (activeShift && activeShift.openedById !== id) {
      // Shift is open under someone else — trigger handoff flow
      setPendingEmployeeSwitch(id);
      return;
    }
    setCurrentEmployeeId(id);
    await safeSet(CURRENT_EMPLOYEE_KEY, id);
    const emp = employees.find((e) => e.id === id);
    notify(`Switched to ${emp ? emp.name : "Staff"}`);
  };

  // Shifts / Cash Drawer Management
  const openShift = async (openingFloat) => {
    const active = shifts.find((s) => !s.closedAt);
    if (active) {
      notify("A shift is already open", "err");
      return;
    }
    const emp = employees.find((e) => e.id === currentEmployeeId);
    const newShift = {
      id: uid("shift"),
      openedAt: Date.now(),
      openedById: currentEmployeeId,
      openedByName: emp ? emp.name : "Staff",
      openingFloat: Number(openingFloat) || 0,
      closedAt: null,
      closedById: null,
      closedByName: null,
      countedCash: null,
      expectedCash: null,
      variance: null,
      note: "",
    };
    const nextShifts = [newShift, ...shifts];
    setShifts(nextShifts);
    await safeSet(SHIFTS_KEY, nextShifts);
    notify("Shift opened successfully");
  };

  const closeShift = async (countedCash, note) => {
    const active = shifts.find((s) => !s.closedAt);
    if (!active) {
      notify("No open shift found", "err");
      return;
    }
    // Calculate expected cash in drawer = opening float + cash sales during shift - cash payouts/waste if any
    const shiftSales = sales.filter((s) => !s.voided && s.timestamp >= active.openedAt);
    const shiftCashSales = shiftSales.reduce((sum, s) => sum + saleCashAmount(s), 0);
    const expectedCash = active.openingFloat + shiftCashSales;
    const counted = Number(countedCash) || 0;
    const variance = counted - expectedCash;

    const emp = employees.find((e) => e.id === currentEmployeeId);
    const closed = {
      ...active,
      closedAt: Date.now(),
      closedById: currentEmployeeId,
      closedByName: emp ? emp.name : "Staff",
      countedCash: counted,
      expectedCash,
      variance,
      note: note || "",
    };

    const nextShifts = shifts.map((s) => (s.id === active.id ? closed : s));
    setShifts(nextShifts);
    await safeSet(SHIFTS_KEY, nextShifts);
    setShiftCloseModal(false);
    notify(`Shift closed. Variance: ${money(variance)}`);
  };

  // Waste & Inventory Audit Logging
  const logWaste = async (data) => {
    const { ingredientId, amount, reason, note, productId, productQty } = data;
    const ings = [...catalog.ingredients];
    const ing = ings.find((i) => i.id === ingredientId);
    if (!ing && !productId) return;

    let cost = 0;
    let name = "";
    let unit = "";

    if (ing) {
      const qty = Number(amount) || 0;
      if (qty <= 0) return;
      if (ing.stock < qty) {
        notify(`Not enough stock. Available: ${ing.stock} ${ing.unit}`, "err");
        return;
      }
      ing.stock = Math.max(0, ing.stock - qty);
      cost = qty * (ing.cost || 0);
      name = ing.name;
      unit = ing.unit;
    } else if (productId) {
      // Whole product waste (e.g. dropped cake or spoiled batch)
      const pq = Number(productQty) || 1;
      const prod = catalog.products.find((p) => p.id === productId);
      if (!prod) return;
      name = prod.name;
      unit = "pcs";
      // Deduct recipe ingredients for each product wasted
      if (prod.recipe) {
        for (const r of prod.recipe) {
          const targetIng = ings.find((i) => i.id === r.ingredientId);
          if (targetIng) {
            const needed = r.amount * pq;
            targetIng.stock = Math.max(0, targetIng.stock - needed);
            cost += needed * (targetIng.cost || 0);
          }
        }
      }
    }

    const nextCatalog = { ...catalog, ingredients: ings };
    setCatalog(nextCatalog);
    await safeSet(CATALOG_KEY, nextCatalog);

    const emp = employees.find((e) => e.id === currentEmployeeId);
    const newWaste = {
      id: uid("waste"),
      timestamp: Date.now(),
      ingredientId: ing ? ing.id : null,
      ingredientName: name,
      unit,
      amount: ing ? Number(amount) : Number(productQty),
      reason,
      note: note || "",
      cost,
      loggedById: currentEmployeeId,
      loggedByName: emp ? emp.name : "Staff",
      productId: productId || null,
      productName: productId ? name : null,
    };

    const nextWaste = [newWaste, ...wasteLogs];
    setWasteLogs(nextWaste);
    await safeSet(WASTE_KEY, nextWaste);
    setWasteModal(false);
    notify("Waste logged and stock adjusted.");
  };

  // Computes active shift summary for reports/drawer check
  const activeShiftInfo = useMemo(() => {
    const active = shifts.find((s) => !s.closedAt);
    if (!active) return null;
    const shiftSales = sales.filter((s) => !s.voided && s.timestamp >= active.openedAt);
    const cashSales = shiftSales.reduce((sum, s) => sum + saleCashAmount(s), 0);
    const onlineSales = shiftSales.reduce((sum, s) => sum + saleOnlineAmount(s), 0);
    const expectedCash = active.openingFloat + cashSales;
    return { ...active, cashSales, onlineSales, expectedCash, totalSales: cashSales + onlineSales };
  }, [shifts, sales]);

  // If the owner hasn't signed in yet, render the clean, self-contained Sign-Up / Login screen.
  if (authChecked && !loggedIn) {
    return (
      <AuthScreen
        authMode={authMode}
        setAuthMode={setAuthMode}
        onSignUp={signUp}
        onLogIn={logIn}
        supportEmail={SUPPORT_EMAIL}
      />
    );
  }

  // If the auth check is still settling on first load, render a lightweight spinner so the screen doesn't flash.
  if (!authChecked || loading) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-stone-900 text-stone-100">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-amber-500" />
          <p className="text-sm text-stone-400">Loading OpSteward QuickServe...</p>
        </div>
      </div>
    );
  }

  // Trial expired gate: if the trial period has ended and the business has not subscribed,
  // show the Paywall / Upgrade screen blocking normal POS usage until payment is completed.
  if (trialInfo.expired && !trialInfo.isSubscribed) {
    return (
      <UpgradeScreen
        account={account}
        paymongoLink={PAYMONGO_LINK}
        supportEmail={SUPPORT_EMAIL}
        onMarkPaid={markSubscriptionActive}
        onLogOut={logOut}
      />
    );
  }

  return (
    <div className="flex h-screen w-full flex-col bg-stone-950 text-stone-100 font-sans select-none overflow-hidden">
      {/* Top Navigation Bar */}
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-stone-800 bg-stone-900 px-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-amber-500 text-stone-950 font-bold shadow">
            <Coffee className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-bold tracking-tight text-stone-100 text-sm">
                {account?.businessName || "OpSteward QuickServe"}
              </span>
              <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-400 border border-amber-500/20">
                POS
              </span>
            </div>
            <div className="flex items-center gap-2 text-[11px] text-stone-400">
              <span>{new Date().toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</span>
              <span>•</span>
              <span className="flex items-center gap-1">
                <Store className="h-3 w-3 text-emerald-400" />
                <span className="text-emerald-400 font-medium">Drawer: {money(activeShiftInfo?.expectedCash ?? 0)}</span>
              </span>
            </div>
          </div>
        </div>

        {/* Navigation Tabs */}
        <nav className="flex items-center gap-1 bg-stone-950/60 p-1 rounded-xl border border-stone-800/80">
          <NavTab active={view === "pos"} onClick={() => setView("pos")} icon={ShoppingCart} label="POS" />
          <NavTab active={view === "catalog"} onClick={() => setView("catalog")} icon={Package} label="Catalog & Stock" />
          <NavTab active={view === "reports"} onClick={() => setView("reports")} icon={BarChart3} label="Reports" />
          <NavTab active={view === "history"} onClick={() => setView("history")} icon={HistoryIcon} label="Sales History" />
          <NavTab active={view === "settings"} onClick={() => setView("settings")} icon={SettingsIcon} label="Settings" />
        </nav>

        {/* Right Side: Employee Selector, Trial/Upgrade Button & User Menu */}
        <div className="flex items-center gap-3">
          {/* Employee Dropdown */}
          <div className="relative flex items-center bg-stone-800/80 border border-stone-700/60 rounded-xl px-2.5 py-1.5 text-xs">
            <span className="text-stone-400 mr-1.5">Staff:</span>
            <select
              value={currentEmployeeId || ""}
              onChange={(e) => switchCurrentEmployee(e.target.value)}
              className="bg-transparent text-stone-200 font-medium focus:outline-none cursor-pointer"
            >
              {employees.map((emp) => (
                <option key={emp.id} value={emp.id} className="bg-stone-900 text-stone-100">
                  {emp.name} ({emp.role})
                </option>
              ))}
            </select>
          </div>

          {/* Trial / Upgrade button */}
          {!trialInfo.isSubscribed && (
            <button
              onClick={() => setShowUpgrade(true)}
              className="flex items-center gap-1.5 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-stone-950 font-semibold px-3 py-1.5 rounded-xl text-xs shadow transition cursor-pointer"
            >
              <span>Trial: {trialInfo.daysLeft}d left</span>
            </button>
          )}

          <button
            onClick={logOut}
            title="Sign Out"
            className="flex items-center justify-center h-8 w-8 rounded-xl bg-stone-800 hover:bg-stone-700 text-stone-300 transition cursor-pointer"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </header>

      {/* Main View Area */}
      <main className="flex-1 overflow-hidden">
        {view === "pos" && (
          <POSView
            catalog={catalog}
            posFilter={posFilter}
            setPosFilter={setPosFilter}
            cart={cart}
            addToCart={addToCart}
            updateCartQty={updateCartQty}
            paymentMethod={paymentMethod}
            setPaymentMethod={setPaymentMethod}
            cashReceived={cashReceived}
            setCashReceived={setCashReceived}
            discountType={discountType}
            setDiscountType={setDiscountType}
            discountValue={discountValue}
            setDiscountValue={setDiscountValue}
            checkoutError={checkoutError}
            setCheckoutError={setCheckoutError}
            onCheckout={checkout}
            paymentProof={paymentProof}
            setPaymentProof={setPaymentProof}
            proofProcessing={proofProcessing}
            handleFileUpload={handleFileUpload}
            splitPayments={splitPayments}
            setSplitPayments={setSplitPayments}
            splitMode={splitMode}
            setSplitMode={setSplitMode}
            splitItemLegs={splitItemLegs}
            setSplitItemLegs={setSplitItemLegs}
            onCheckoutSplit={checkoutSplit}
            activeShiftInfo={activeShiftInfo}
            setShiftCloseModal={setShiftCloseModal}
            setWasteModal={setWasteModal}
          />
        )}

        {view === "catalog" && (
          <CatalogStockView
            catalog={catalog}
            setIngModal={setIngModal}
            setProdModal={setProdModal}
            setCatModal={setCatModal}
            restockId={restockId}
            setRestockId={setRestockId}
            restockVal={restockVal}
            setRestockVal={setRestockVal}
            onRestock={restockIngredient}
            onDeleteProduct={deleteProduct}
            onDeleteIngredient={deleteIngredient}
          />
        )}

        {view === "reports" && (
          <ReportsView
            sales={sales}
            wasteLogs={wasteLogs}
            reportMode={reportMode}
            setReportMode={setReportMode}
            reportDay={reportDay}
            setReportDay={setReportDay}
            reportMonth={reportMonth}
            setReportMonth={setReportMonth}
            reportRangeStart={reportRangeStart}
            setReportRangeStart={setReportRangeStart}
            reportRangeEnd={reportRangeEnd}
            setReportRangeEnd={setReportRangeEnd}
            currencyCode={currencyCode}
          />
        )}

        {view === "history" && (
          <SalesHistoryView
            sales={sales}
            historyMode={historyMode}
            setHistoryMode={setHistoryMode}
            historyDay={historyDay}
            setHistoryDay={setHistoryDay}
            historyRangeStart={historyRangeStart}
            setHistoryRangeStart={setHistoryRangeStart}
            historyRangeEnd={historyRangeEnd}
            setHistoryRangeEnd={setHistoryRangeEnd}
            onVoidSale={(sale) => setVoidModal(sale)}
            onRestoreSale={(sale) => setRestoreModal(sale)}
            onInspectSale={(sale) => setDetailSale(sale)}
            employees={employees}
            onVoidItem={(saleId, itemIdx, reason, pin) => voidSaleItem(saleId, itemIdx, reason, pin)}
          />
        )}

        {view === "settings" && (
          <SettingsView
            account={account}
            onUpdateField={updateAccountField}
            currencyCode={currencyCode}
            onChangeCurrency={changeCurrency}
            employees={employees}
            onAddEmployee={addEmployee}
            onUpdateEmployee={updateEmployee}
            onDeleteEmployee={deleteEmployee}
            shifts={shifts}
            onOpenShift={openShift}
            onCloseShift={closeShift}
            activeShiftInfo={activeShiftInfo}
            onResetData={() => setConfirmReset(true)}
            supportEmail={SUPPORT_EMAIL}
            paymongoLink={PAYMONGO_LINK}
            onShowUpgrade={() => setShowUpgrade(true)}
          />
        )}
      </main>

      {/* Modals */}
      {receipt && (
        <ReceiptModal
          receipt={receipt}
          onClose={() => setReceipt(null)}
          businessName={account?.businessName || "OpSteward QuickServe"}
        />
      )}

      {ingModal !== null && (
        <IngredientModal
          ingredient={ingModal.id ? ingModal : null}
          onClose={() => setIngModal(null)}
          onSave={(ing) => {
            if (ingModal.id) updateIngredient(ing);
            else addIngredient(ing);
            setIngModal(null);
          }}
        />
      )}

      {prodModal !== null && (
        <ProductModal
          product={prodModal.id ? prodModal : null}
          categories={catalog.categories}
          ingredients={catalog.ingredients}
          onClose={() => setProdModal(null)}
          onSave={(prod) => {
            if (prodModal.id) updateProduct(prod);
            else addProduct(prod);
            setProdModal(null);
          }}
        />
      )}

      {catModal && (
        <CategoryModal
          onClose={() => setCatModal(false)}
          onSave={(name) => {
            addCategory(name);
            setCatModal(false);
          }}
        />
      )}

      {voidModal && (
        <VoidModal
          sale={voidModal}
          onClose={() => setVoidModal(null)}
          onConfirm={(reason) => voidSale(voidModal.id, reason)}
        />
      )}

      {restoreModal && (
        <RestoreModal
          sale={restoreModal}
          employees={employees}
          onClose={() => setRestoreModal(null)}
          onConfirm={(managerPin) => restoreVoidedSale(restoreModal.id, managerPin)}
        />
      )}

      {detailSale && (
        <SaleDetailModal
          sale={detailSale}
          onClose={() => setDetailSale(null)}
          employees={employees}
          onVoidItem={(saleId, itemIdx, reason, pin) => voidSaleItem(saleId, itemIdx, reason, pin)}
        />
      )}

      {wasteModal && (
        <WasteModal
          catalog={catalog}
          onClose={() => setWasteModal(false)}
          onSave={logWaste}
        />
      )}

      {shiftCloseModal && (
        <ShiftCloseModal
          activeShiftInfo={activeShiftInfo}
          onClose={() => setShiftCloseModal(false)}
          onConfirm={closeShift}
        />
      )}

      {pendingEmployeeSwitch && (
        <HandoffModal
          outgoingShift={activeShiftInfo}
          incomingEmployee={employees.find((e) => e.id === pendingEmployeeSwitch)}
          onClose={() => setPendingEmployeeSwitch(null)}
          onCompleteHandoff={async (countedCash, note, newFloat) => {
            // Close active shift
            await closeShift(countedCash, note);
            // Switch employee
            setCurrentEmployeeId(pendingEmployeeSwitch);
            await safeSet(CURRENT_EMPLOYEE_KEY, pendingEmployeeSwitch);
            // Open new shift for incoming employee with new float
            await openShift(newFloat);
            setPendingEmployeeSwitch(null);
          }}
        />
      )}

      {showUpgrade && (
        <UpgradeModal
          account={account}
          paymongoLink={PAYMONGO_LINK}
          supportEmail={SUPPORT_EMAIL}
          onMarkPaid={markSubscriptionActive}
          onClose={() => setShowUpgrade(false)}
        />
      )}

      {confirmReset && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-2xl bg-stone-900 border border-stone-800 p-6 shadow-2xl">
            <div className="flex items-center gap-3 text-red-400 mb-3">
              <AlertTriangle className="h-6 w-6" />
              <h3 className="text-lg font-bold">Reset All Local POS Data?</h3>
            </div>
            <p className="text-sm text-stone-300 mb-6">
              This will erase all sales history, catalog items, and shift logs on this device and restore the default sample café menu. Your account login remains active. This cannot be undone.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setConfirmReset(false)}
                className="px-4 py-2 rounded-xl bg-stone-800 hover:bg-stone-700 text-stone-200 text-sm font-medium transition cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  const fresh = seedCatalog();
                  await safeSet(CATALOG_KEY, fresh);
                  await safeSet(SALES_KEY, []);
                  await safeSet(SHIFTS_KEY, []);
                  await safeSet(WASTE_KEY, []);
                  await safeSet(ORDER_COUNTER_KEY, 1);
                  setCatalog(fresh);
                  setSales([]);
                  setNextOrderNo(1);
                  setShifts([]);
                  setWasteLogs([]);
                  setConfirmReset(false);
                  notify("POS data reset successfully");
                }}
                className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white text-sm font-semibold transition cursor-pointer"
              >
                Yes, Reset POS Data
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast Notification */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2.5 rounded-2xl bg-stone-900 border border-stone-700 px-4 py-3 text-stone-100 shadow-2xl animate-fade-in">
          {toast.type === "err" ? (
            <AlertTriangle className="h-5 w-5 text-red-400 shrink-0" />
          ) : (
            <CheckCircle2 className="h-5 w-5 text-emerald-400 shrink-0" />
          )}
          <span className="text-sm font-medium">{toast.msg}</span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function NavTab({ active, onClick, icon: Icon, label }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold transition cursor-pointer ${
        active
          ? "bg-amber-500 text-stone-950 shadow"
          : "text-stone-400 hover:text-stone-200 hover:bg-stone-900"
      }`}
    >
      <Icon className="h-4 w-4" />
      <span>{label}</span>
    </button>
  );
}

// ===========================================================================
// AUTH SCREEN (Sign-Up / Login)
// ===========================================================================
function AuthScreen({ authMode, setAuthMode, onSignUp, onLogIn, supportEmail }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [referralCode, setReferralCode] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!email.trim() || !password.trim()) return;
    setLoading(true);
    if (authMode === "signup") {
      if (!businessName.trim()) {
        alert("Please enter your business name.");
        setLoading(false);
        return;
      }
      await onSignUp({ businessName, email, password, referralCode });
    } else {
      const ok = await onLogIn({ email, password });
      if (!ok) {
        alert("Login failed. Check your email and password, or sign up for a new account.");
      }
    }
    setLoading(false);
  };

  return (
    <div className="flex h-screen w-full items-center justify-center bg-stone-950 text-stone-100 p-4">
      <div className="w-full max-w-md rounded-3xl bg-stone-900 border border-stone-800 p-8 shadow-2xl">
        <div className="flex flex-col items-center text-center mb-6">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-500 text-stone-950 shadow-lg mb-3">
            <Coffee className="h-7 w-7" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-stone-100">OpSteward QuickServe</h1>
          <p className="text-xs text-stone-400 mt-1">
            {authMode === "signup"
              ? `Start your ${TRIAL_DAYS}-day free trial. No credit card required.`
              : "Sign in to manage your café POS and inventory."}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {authMode === "signup" && (
            <>
              <div>
                <label className="block text-xs font-medium text-stone-300 mb-1">Business / Café Name</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Bean & Bread Café"
                  value={businessName}
                  onChange={(e) => setBusinessName(e.target.value)}
                  className="w-full rounded-xl bg-stone-950 border border-stone-800 px-3.5 py-2.5 text-sm text-stone-100 placeholder-stone-600 focus:border-amber-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-stone-300 mb-1">
                  Referral Code <span className="text-stone-500">(Optional — gives you {REFERRAL_DISCOUNT_PERCENT}% off)</span>
                </label>
                <input
                  type="text"
                  placeholder="e.g. OP-ABC12"
                  value={referralCode}
                  onChange={(e) => setReferralCode(e.target.value)}
                  className="w-full rounded-xl bg-stone-950 border border-stone-800 px-3.5 py-2.5 text-sm text-stone-100 placeholder-stone-600 focus:border-amber-500 focus:outline-none uppercase"
                />
              </div>
            </>
          )}

          <div>
            <label className="block text-xs font-medium text-stone-300 mb-1">Email Address</label>
            <input
              type="email"
              required
              placeholder="owner@cafe.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-xl bg-stone-950 border border-stone-800 px-3.5 py-2.5 text-sm text-stone-100 placeholder-stone-600 focus:border-amber-500 focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-stone-300 mb-1">Password</label>
            <input
              type="password"
              required
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-xl bg-stone-950 border border-stone-800 px-3.5 py-2.5 text-sm text-stone-100 placeholder-stone-600 focus:border-amber-500 focus:outline-none"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full flex items-center justify-center gap-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-stone-950 font-semibold py-3 text-sm shadow transition cursor-pointer disabled:opacity-50"
          >
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            <span>{authMode === "signup" ? `Start ${TRIAL_DAYS}-Day Free Trial` : "Sign In"}</span>
          </button>
        </form>

        <div className="mt-6 flex flex-col items-center gap-3 text-center">
          <button
            onClick={() => setAuthMode(authMode === "signup" ? "login" : "signup")}
            className="text-xs text-amber-400 hover:underline cursor-pointer"
          >
            {authMode === "signup" ? "Already have an account? Sign in" : `Don't have an account? Start ${TRIAL_DAYS}-day trial`}
          </button>

          <p className="text-[11px] text-stone-500">
            Need help? Contact support at{" "}
            <a href={`mailto:${supportEmail}`} className="text-stone-400 underline">{supportEmail}</a>
          </p>
        </div>
      </div>
    </div>
  );
}

// ===========================================================================
// UPGRADE / PAYWALL SCREEN
// ===========================================================================
function UpgradeScreen({ account, paymongoLink, supportEmail, onMarkPaid, onLogOut }) {
  const [reference, setReference] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleVerify = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    await onMarkPaid(reference.trim() || "PAID");
    setSubmitting(false);
  };

  return (
    <div className="flex h-screen w-full items-center justify-center bg-stone-950 text-stone-100 p-4 overflow-y-auto">
      <div className="w-full max-w-lg rounded-3xl bg-stone-900 border border-stone-800 p-8 shadow-2xl">
        <div className="flex flex-col items-center text-center mb-6">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-500/10 border border-amber-500/20 text-amber-400 shadow-lg mb-3">
            <Coins className="h-7 w-7" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-stone-100">Your Free Trial Has Ended</h1>
          <p className="text-xs text-stone-400 mt-1">
            To continue using OpSteward QuickServe for <span className="text-stone-200 font-medium">{account?.businessName}</span>, please complete your subscription payment.
          </p>
        </div>

        <div className="rounded-2xl bg-stone-950 border border-stone-800 p-5 mb-6 space-y-4">
          <div>
            <h3 className="text-sm font-bold text-stone-200 mb-1">1. Pay via PayMongo (GCash, Maya, Cards)</h3>
            <p className="text-xs text-stone-400 mb-3">Click the link below to open our secure checkout page:</p>
            <a
              href={paymongoLink}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center w-full rounded-xl bg-amber-500 hover:bg-amber-400 text-stone-950 font-semibold py-3 text-xs shadow transition text-center"
            >
              Open Secure PayMongo Checkout ↗
            </a>
          </div>

          <div className="border-t border-stone-800 pt-4">
            <h3 className="text-sm font-bold text-stone-200 mb-1">2. Enter Payment Reference / Confirmation</h3>
            <p className="text-xs text-stone-400 mb-3">After paying, paste your reference number or receipt code below and click verify:</p>
            <form onSubmit={handleVerify} className="space-y-3">
              <input
                type="text"
                placeholder="e.g. PM-948201 or GCash Ref No."
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                className="w-full rounded-xl bg-stone-900 border border-stone-800 px-3.5 py-2.5 text-sm text-stone-100 placeholder-stone-600 focus:border-amber-500 focus:outline-none"
              />
              <button
                type="submit"
                disabled={submitting}
                className="w-full flex items-center justify-center gap-2 rounded-xl bg-stone-800 hover:bg-stone-700 text-stone-100 font-semibold py-2.5 text-xs border border-stone-700 transition cursor-pointer disabled:opacity-50"
              >
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                <span>Verify & Activate Subscription</span>
              </button>
            </form>
          </div>
        </div>

        <div className="flex items-center justify-between text-xs text-stone-500">
          <span>Questions? <a href={`mailto:${supportEmail}`} className="text-amber-400 underline">{supportEmail}</a></span>
          <button onClick={onLogOut} className="hover:text-stone-300 underline cursor-pointer">Sign Out</button>
        </div>
      </div>
    </div>
  );
}

// ===========================================================================
// UPGRADE MODAL (Accessed from top bar or settings while in trial)
// ===========================================================================
function UpgradeModal({ account, paymongoLink, supportEmail, onMarkPaid, onClose }) {
  const [reference, setReference] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleVerify = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    await onMarkPaid(reference.trim() || "PAID");
    setSubmitting(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="w-full max-w-md rounded-3xl bg-stone-900 border border-stone-800 p-6 shadow-2xl relative">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-stone-400 hover:text-stone-200 cursor-pointer"
        >
          <X className="h-5 w-5" />
        </button>

        <div className="flex items-center gap-3 mb-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/10 text-amber-400">
            <Coins className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-lg font-bold text-stone-100">Upgrade Subscription</h3>
            <p className="text-xs text-stone-400">Unlock full lifetime access for {account?.businessName}</p>
          </div>
        </div>

        <div className="space-y-4 mb-6">
          <div>
            <label className="block text-xs font-medium text-stone-300 mb-1">1. Pay via PayMongo</label>
            <a
              href={paymongoLink}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center w-full rounded-xl bg-amber-500 hover:bg-amber-400 text-stone-950 font-semibold py-2.5 text-xs shadow transition"
            >
              Open PayMongo Checkout ↗
            </a>
          </div>

          <form onSubmit={handleVerify} className="space-y-3">
            <label className="block text-xs font-medium text-stone-300">2. Enter Payment Reference</label>
            <input
              type="text"
              placeholder="e.g. PM-948201"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              className="w-full rounded-xl bg-stone-950 border border-stone-800 px-3.5 py-2.5 text-sm text-stone-100 focus:border-amber-500 focus:outline-none"
            />
            <button
              type="submit"
              disabled={submitting}
              className="w-full flex items-center justify-center gap-2 rounded-xl bg-stone-800 hover:bg-stone-700 text-stone-100 font-semibold py-2.5 text-xs border border-stone-700 transition cursor-pointer disabled:opacity-50"
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              <span>Verify & Activate</span>
            </button>
          </form>
        </div>

        <p className="text-[11px] text-stone-500 text-center">
          Need assistance? Email <a href={`mailto:${supportEmail}`} className="text-stone-400 underline">{supportEmail}</a>
        </p>
      </div>
    </div>
  );
}

// ===========================================================================
// POS VIEW
// ===========================================================================
function POSView({
  catalog,
  posFilter,
  setPosFilter,
  cart,
  addToCart,
  updateCartQty,
  paymentMethod,
  setPaymentMethod,
  cashReceived,
  setCashReceived,
  discountType,
  setDiscountType,
  discountValue,
  setDiscountValue,
  checkoutError,
  setCheckoutError,
  onCheckout,
  paymentProof,
  setPaymentProof,
  proofProcessing,
  handleFileUpload,
  splitPayments,
  setSplitPayments,
  splitMode,
  setSplitMode,
  splitItemLegs,
  setSplitItemLegs,
  onCheckoutSplit,
  activeShiftInfo,
  setShiftCloseModal,
  setWasteModal,
}) {
  const [search, setSearch] = useState("");
  const [isSplit, setIsSplit] = useState(false);

  const filteredProducts = useMemo(() => {
    return catalog.products.filter((p) => {
      const matchCat = posFilter === "all" || p.category === posFilter;
      const matchSearch = p.name.toLowerCase().includes(search.toLowerCase());
      return matchCat && matchSearch;
    });
  }, [catalog.products, posFilter, search]);

  const subtotal = useMemo(() => {
    return cart.reduce((sum, ci) => {
      const p = catalog.products.find((x) => x.id === ci.productId);
      return sum + (p ? p.price * ci.qty : 0);
    }, 0);
  }, [cart, catalog.products]);

  const discountAmount = useMemo(() => {
    const val = Number(discountValue) || 0;
    if (discountType === "percent") {
      return (subtotal * Math.min(100, Math.max(0, val))) / 100;
    } else if (discountType === "amount") {
      return Math.min(subtotal, Math.max(0, val));
    }
    return 0;
  }, [subtotal, discountType, discountValue]);

  const total = Math.max(0, subtotal - discountAmount);
  const cashNum = Number(cashReceived) || 0;
  const change = paymentMethod === "cash" ? Math.max(0, cashNum - total) : 0;

  return (
    <div className="flex h-full w-full overflow-hidden bg-stone-950">
      {/* Left: Catalog / Menu Grid */}
      <div className="flex flex-1 flex-col border-r border-stone-800 overflow-hidden">
        {/* Search & Categories Header */}
        <div className="flex flex-col gap-3 p-4 border-b border-stone-800 bg-stone-900/40">
          <div className="flex items-center gap-3">
            <input
              type="text"
              placeholder="Search products..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="flex-1 rounded-xl bg-stone-900 border border-stone-800 px-3.5 py-2 text-xs text-stone-100 placeholder-stone-500 focus:border-amber-500 focus:outline-none"
            />
            <button
              onClick={() => setWasteModal(true)}
              className="flex items-center gap-1.5 rounded-xl bg-stone-800 hover:bg-stone-700 text-stone-300 px-3 py-2 text-xs font-medium border border-stone-700 transition cursor-pointer"
            >
              <Trash2 className="h-3.5 w-3.5 text-amber-400" />
              <span>Log Waste</span>
            </button>
            <button
              onClick={() => setShiftCloseModal(true)}
              className="flex items-center gap-1.5 rounded-xl bg-stone-800 hover:bg-stone-700 text-stone-300 px-3 py-2 text-xs font-medium border border-stone-700 transition cursor-pointer"
            >
              <ReceiptIcon className="h-3.5 w-3.5 text-emerald-400" />
              <span>Drawer / Shift</span>
            </button>
          </div>

          {/* Category Tabs */}
          <div className="flex items-center gap-2 overflow-x-auto pb-1">
            <button
              onClick={() => setPosFilter("all")}
              className={`rounded-xl px-3.5 py-1.5 text-xs font-semibold whitespace-nowrap transition cursor-pointer ${
                posFilter === "all"
                  ? "bg-amber-500 text-stone-950 shadow"
                  : "bg-stone-900 text-stone-400 hover:text-stone-200 border border-stone-800"
              }`}
            >
              All Items
            </button>
            {catalog.categories.map((cat) => {
              const Icon = categoryIcon(cat.id);
              return (
                <button
                  key={cat.id}
                  onClick={() => setPosFilter(cat.id)}
                  className={`flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-xs font-semibold whitespace-nowrap transition cursor-pointer ${
                    posFilter === cat.id
                      ? "bg-amber-500 text-stone-950 shadow"
                      : "bg-stone-900 text-stone-400 hover:text-stone-200 border border-stone-800"
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  <span>{cat.name}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Product Cards Grid */}
        <div className="flex-1 overflow-y-auto p-4">
          {filteredProducts.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center text-stone-500">
              <Package className="h-10 w-10 mb-2 opacity-40" />
              <p className="text-sm">No products found</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
              {filteredProducts.map((prod) => {
                const Icon = categoryIcon(prod.category);
                return (
                  <button
                    key={prod.id}
                    onClick={() => addToCart(prod)}
                    className="flex flex-col justify-between rounded-2xl bg-stone-900/80 hover:bg-stone-900 border border-stone-800/80 hover:border-amber-500/50 p-4 text-left transition group cursor-pointer shadow-sm"
                  >
                    <div className="flex items-center justify-between w-full mb-3">
                      <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-amber-500/10 text-amber-400 group-hover:bg-amber-500 group-hover:text-stone-950 transition">
                        <Icon className="h-4 w-4" />
                      </div>
                      <span className="text-xs font-bold text-stone-300">{money(prod.price)}</span>
                    </div>
                    <div>
                      <h4 className="text-xs font-bold text-stone-100 line-clamp-2 mb-1">{prod.name}</h4>
                      <span className="text-[10px] text-stone-500 uppercase tracking-wider">{prod.category}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Right: Cart & Checkout Panel */}
      <div className="flex w-[400px] flex-col bg-stone-900 border-l border-stone-800 overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b border-stone-800 bg-stone-900/80">
          <div className="flex items-center gap-2">
            <ShoppingCart className="h-4 w-4 text-amber-400" />
            <h3 className="text-sm font-bold text-stone-100">Current Order</h3>
          </div>
          {cart.length > 0 && (
            <button
              onClick={() => setCart([])}
              className="text-xs text-stone-400 hover:text-red-400 transition cursor-pointer"
            >
              Clear Cart
            </button>
          )}
        </div>

        {/* Cart Items List */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {cart.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center text-stone-500">
              <ShoppingCart className="h-10 w-10 mb-2 opacity-30" />
              <p className="text-xs">Cart is empty. Tap items to add.</p>
            </div>
          ) : (
            cart.map((ci) => {
              const prod = catalog.products.find((p) => p.id === ci.productId);
              if (!prod) return null;
              return (
                <div key={ci.productId} className="flex items-center justify-between rounded-xl bg-stone-950 border border-stone-800/80 p-3">
                  <div className="flex-1 min-w-0 mr-3">
                    <h4 className="text-xs font-semibold text-stone-200 truncate">{prod.name}</h4>
                    <span className="text-[11px] text-stone-400">{money(prod.price)} each</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => updateCartQty(ci.productId, -1)}
                      className="flex h-6 w-6 items-center justify-center rounded-lg bg-stone-800 hover:bg-stone-700 text-stone-300 text-xs transition cursor-pointer"
                    >
                      <Minus className="h-3 w-3" />
                    </button>
                    <span className="text-xs font-bold text-stone-100 w-5 text-center">{ci.qty}</span>
                    <button
                      onClick={() => updateCartQty(ci.productId, 1)}
                      className="flex h-6 w-6 items-center justify-center rounded-lg bg-stone-800 hover:bg-stone-700 text-stone-300 text-xs transition cursor-pointer"
                    >
                      <Plus className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Checkout Summary & Controls */}
        <div className="border-t border-stone-800 bg-stone-900/90 p-4 space-y-3">
          {/* Discount Selector */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-stone-400">Discount:</span>
            <select
              value={discountType}
              onChange={(e) => setDiscountType(e.target.value)}
              className="rounded-lg bg-stone-950 border border-stone-800 px-2 py-1 text-xs text-stone-200 focus:outline-none"
            >
              <option value="none">None</option>
              <option value="percent">Percentage (%)</option>
              <option value="amount">Fixed Amount</option>
            </select>
            {discountType !== "none" && (
              <input
                type="number"
                placeholder={discountType === "percent" ? "e.g. 10" : "e.g. 50"}
                value={discountValue}
                onChange={(e) => setDiscountValue(e.target.value)}
                className="w-20 rounded-lg bg-stone-950 border border-stone-800 px-2 py-1 text-xs text-stone-200 focus:outline-none"
              />
            )}
          </div>

          {/* Payment Method Switcher */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => { setIsSplit(false); setPaymentMethod("cash"); }}
                  className={`flex-1 rounded-xl py-2 px-3 text-xs font-semibold transition cursor-pointer flex items-center justify-center gap-1.5 ${
                    !isSplit && paymentMethod === "cash"
                      ? "bg-amber-500 text-stone-950 shadow"
                      : "bg-stone-950 text-stone-400 border border-stone-800 hover:text-stone-200"
                  }`}
                >
                  <Banknote className="h-3.5 w-3.5" />
                  <span>Cash</span>
                </button>
                <button
                  onClick={() => { setIsSplit(false); setPaymentMethod("online"); }}
                  className={`flex-1 rounded-xl py-2 px-3 text-xs font-semibold transition cursor-pointer flex items-center justify-center gap-1.5 ${
                    !isSplit && paymentMethod === "online"
                      ? "bg-amber-500 text-stone-950 shadow"
                      : "bg-stone-950 text-stone-400 border border-stone-800 hover:text-stone-200"
                  }`}
                >
                  <CreditCard className="h-3.5 w-3.5" />
                  <span>Online / GCash</span>
                </button>
                <button
                  onClick={() => setIsSplit(true)}
                  className={`flex-1 rounded-xl py-2 px-3 text-xs font-semibold transition cursor-pointer flex items-center justify-center gap-1.5 ${
                    isSplit
                      ? "bg-amber-500 text-stone-950 shadow"
                      : "bg-stone-950 text-stone-400 border border-stone-800 hover:text-stone-200"
                  }`}
                >
                  <Coins className="h-3.5 w-3.5" />
                  <span>Split</span>
                </button>
              </div>
            </div>

            {/* Cash Tendered Input */}
            {!isSplit && paymentMethod === "cash" && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-stone-400">Cash Recv:</span>
                <input
                  type="number"
                  placeholder="0.00"
                  value={cashReceived}
                  onChange={(e) => setCashReceived(e.target.value)}
                  className="flex-1 rounded-xl bg-stone-950 border border-stone-800 px-3 py-1.5 text-xs text-stone-100 focus:border-amber-500 focus:outline-none"
                />
              </div>
            )}

            {/* Online payment proof upload */}
            {!isSplit && paymentMethod === "online" && (
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1.5 flex-1 rounded-xl bg-stone-950 border border-stone-800 px-3 py-1.5 text-xs text-stone-300 hover:bg-stone-800 transition cursor-pointer">
                  {proofProcessing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Camera className="h-3.5 w-3.5 text-amber-400" />}
                  <span className="truncate">{paymentProof ? "Screenshot Attached" : "Attach GCash Receipt (Optional)"}</span>
                  <input type="file" accept="image/*" onChange={handleFileUpload} className="hidden" />
                </label>
                {paymentProof && (
                  <button onClick={() => setPaymentProof(null)} className="text-xs text-red-400 hover:underline">Remove</button>
                )}
              </div>
            )}

            {/* Split Payment Builder */}
            {isSplit && (
              <div className="rounded-xl bg-stone-950 border border-stone-800 p-3 space-y-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-stone-300">Split Breakdown</span>
                  <div className="flex items-center gap-1 bg-stone-900 rounded-lg p-0.5 border border-stone-800">
                    <button
                      onClick={() => setSplitMode("amount")}
                      className={`px-2 py-0.5 rounded text-[10px] font-medium transition cursor-pointer ${splitMode === 'amount' ? 'bg-amber-500 text-stone-950' : 'text-stone-400'}`}
                    >
                      By Amount
                    </button>
                    <button
                      onClick={() => setSplitMode("items")}
                      className={`px-2 py-0.5 rounded text-[10px] font-medium transition cursor-pointer ${splitMode === 'items' ? 'bg-amber-500 text-stone-950' : 'text-stone-400'}`}
                    >
                      By Items
                    </button>
                  </div>
                </div>

                {splitMode === "amount" ? (
                  <>
                    <div className="space-y-2 max-h-32 overflow-y-auto">
                      {splitPayments.map((leg, idx) => (
                        <div key={idx} className="flex items-center gap-2">
                          <select
                            value={leg.method}
                            onChange={(e) => {
                              const next = [...splitPayments];
                              next[idx].method = e.target.value;
                              setSplitPayments(next);
                            }}
                            className="rounded-lg bg-stone-900 border border-stone-800 px-2 py-1 text-xs text-stone-200 focus:outline-none"
                          >
                            <option value="cash">Cash</option>
                            <option value="online">Online</option>
                          </select>
                          <input
                            type="number"
                            placeholder={idx === splitPayments.length - 1 ? "Remainder" : "Amount"}
                            value={leg.amount}
                            onChange={(e) => {
                              const next = [...splitPayments];
                              next[idx].amount = e.target.value;
                              setSplitPayments(next);
                            }}
                            className="flex-1 rounded-lg bg-stone-900 border border-stone-800 px-2.5 py-1 text-xs text-stone-100 focus:outline-none"
                          />
                          {splitPayments.length > 2 && (
                            <button
                              onClick={() => setSplitPayments(splitPayments.filter((_, i) => i !== idx))}
                              className="text-stone-500 hover:text-red-400"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                    <button
                      onClick={() => setSplitPayments([...splitPayments, { method: "cash", amount: "" }])}
                      className="text-[11px] text-amber-400 hover:underline flex items-center gap-1 cursor-pointer"
                    >
                      <Plus className="h-3 w-3" /> Add payment leg
                    </button>
                  </>
                ) : (
                  <div className="space-y-2 max-h-36 overflow-y-auto">
                    {cart.map((ci) => {
                      const prod = catalog.products.find((p) => p.id === ci.productId);
                      if (!prod) return null;
                      return (
                        <div key={ci.productId} className="flex items-center justify-between text-xs bg-stone-900 p-2 rounded-lg">
                          <span className="truncate mr-2 text-stone-200">{prod.name} ({money(prod.price * ci.qty)})</span>
                          <select
                            value={splitItemLegs[ci.productId] ?? 0}
                            onChange={(e) => setSplitItemLegs({ ...splitItemLegs, [ci.productId]: Number(e.target.value) })}
                            className="rounded bg-stone-950 border border-stone-800 px-2 py-0.5 text-xs text-amber-400 focus:outline-none"
                          >
                            {splitPayments.map((leg, idx) => (
                              <option key={idx} value={idx}>
                                Leg {idx + 1} ({leg.method})
                              </option>
                            ))}
                          </select>
                        </div>
                      );
                    })}
                    <button
                      onClick={() => setSplitPayments([...splitPayments, { method: "cash", amount: "" }])}
                      className="text-[11px] text-amber-400 hover:underline flex items-center gap-1 cursor-pointer mt-1"
                    >
                      <Plus className="h-3 w-3" /> Add payer leg
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {checkoutError && (
            <div className="rounded-xl bg-red-950/50 border border-red-800/60 p-2.5 text-xs text-red-300 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 text-red-400" />
              <span>{checkoutError}</span>
            </div>
          )}

          {/* Totals & Checkout Button */}
          <div className="space-y-1.5 pt-2 border-t border-stone-800">
            <div className="flex justify-between text-xs text-stone-400">
              <span>Subtotal</span>
              <span>{money(subtotal)}</span>
            </div>
            {discountAmount > 0 && (
              <div className="flex justify-between text-xs text-emerald-400">
                <span>Discount</span>
                <span>-{money(discountAmount)}</span>
              </div>
            )}
            <div className="flex justify-between text-base font-bold text-stone-100">
              <span>Total</span>
              <span className="text-amber-400">{money(total)}</span>
            </div>
            {!isSplit && paymentMethod === "cash" && cashNum >= total && (
              <div className="flex justify-between text-xs font-semibold text-emerald-400">
                <span>Change Due</span>
                <span>{money(change)}</span>
              </div>
            )}
          </div>

          <button
            onClick={isSplit ? onCheckoutSplit : onCheckout}
            disabled={cart.length === 0}
            className="w-full rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-40 text-stone-950 font-bold py-3 text-sm shadow transition cursor-pointer flex items-center justify-center gap-2"
          >
            <Check className="h-4 w-4" />
            <span>Complete Order ({money(total)})</span>
          </button>
        </div>
      </div>
    </div>
  );
}

// ===========================================================================
// CATALOG & STOCK VIEW
// ===========================================================================
function CatalogStockView({
  catalog,
  setIngModal,
  setProdModal,
  setCatModal,
  restockId,
  setRestockId,
  restockVal,
  setRestockVal,
  onRestock,
  onDeleteProduct,
  onDeleteIngredient,
}) {
  const [tab, setTab] = useState("products");

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-stone-950 p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-stone-100">Catalog & Stock Management</h2>
          <p className="text-xs text-stone-400">Manage products, recipes, inventory ingredients, and stock levels.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setCatModal(true)}
            className="flex items-center gap-1.5 rounded-xl bg-stone-800 hover:bg-stone-700 text-stone-200 px-3.5 py-2 text-xs font-semibold border border-stone-700 transition cursor-pointer"
          >
            <Plus className="h-4 w-4 text-amber-400" />
            <span>Add Category</span>
          </button>
          <button
            onClick={() => setIngModal({})}
            className="flex items-center gap-1.5 rounded-xl bg-stone-800 hover:bg-stone-700 text-stone-200 px-3.5 py-2 text-xs font-semibold border border-stone-700 transition cursor-pointer"
          >
            <Plus className="h-4 w-4 text-amber-400" />
            <span>Add Ingredient</span>
          </button>
          <button
            onClick={() => setProdModal({})}
            className="flex items-center gap-1.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-stone-950 px-3.5 py-2 text-xs font-semibold shadow transition cursor-pointer"
          >
            <Plus className="h-4 w-4" />
            <span>Add Product</span>
          </button>
        </div>
      </div>

      {/* Sub-tabs */}
      <div className="flex items-center gap-2 mb-4">
        <button
          onClick={() => setTab("products")}
          className={`rounded-xl px-4 py-2 text-xs font-semibold transition cursor-pointer ${
            tab === "products" ? "bg-amber-500 text-stone-950 shadow" : "bg-stone-900 text-stone-400 border border-stone-800"
          }`}
        >
          Products ({catalog.products.length})
        </button>
        <button
          onClick={() => setTab("ingredients")}
          className={`rounded-xl px-4 py-2 text-xs font-semibold transition cursor-pointer ${
            tab === "ingredients" ? "bg-amber-500 text-stone-950 shadow" : "bg-stone-900 text-stone-400 border border-stone-800"
          }`}
        >
          Ingredients & Stock ({catalog.ingredients.length})
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto rounded-2xl bg-stone-900 border border-stone-800">
        {tab === "products" ? (
          <div className="divide-y divide-stone-800">
            {catalog.products.map((p) => {
              const Icon = categoryIcon(p.category);
              return (
                <div key={p.id} className="flex items-center justify-between p-4 hover:bg-stone-800/40 transition">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/10 text-amber-400">
                      <Icon className="h-5 w-5" />
                    </div>
                    <div>
                      <h4 className="text-sm font-bold text-stone-100">{p.name}</h4>
                      <p className="text-xs text-stone-400">
                        Category: <span className="text-stone-300 capitalize">{p.category}</span> • Price: <span className="text-amber-400 font-semibold">{money(p.price)}</span>
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setProdModal(p)}
                      className="flex items-center gap-1 rounded-xl bg-stone-800 hover:bg-stone-700 text-stone-200 px-3 py-1.5 text-xs font-medium border border-stone-700 transition cursor-pointer"
                    >
                      <Pencil className="h-3.5 w-3.5 text-amber-400" />
                      <span>Edit</span>
                    </button>
                    <button
                      onClick={() => onDeleteProduct(p.id)}
                      className="flex items-center gap-1 rounded-xl bg-red-950/40 hover:bg-red-900/60 text-red-300 px-3 py-1.5 text-xs font-medium border border-red-800/60 transition cursor-pointer"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="divide-y divide-stone-800">
            {catalog.ingredients.map((ing) => {
              const isLow = ing.stock <= ing.low;
              return (
                <div key={ing.id} className="flex items-center justify-between p-4 hover:bg-stone-800/40 transition">
                  <div>
                    <div className="flex items-center gap-2">
                      <h4 className="text-sm font-bold text-stone-100">{ing.name}</h4>
                      {isLow && (
                        <span className="flex items-center gap-1 rounded bg-red-950 border border-red-800 px-2 py-0.5 text-[10px] font-semibold text-red-400">
                          <AlertTriangle className="h-3 w-3" /> Low Stock
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-stone-400">
                      Stock: <span className={`font-semibold ${isLow ? "text-red-400" : "text-emerald-400"}`}>{ing.stock} {unitLabel(ing.unit)}</span> (Low alert at {ing.low}) • Cost: {money(ing.cost)}/{unitLabel(ing.unit)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {restockId === ing.id ? (
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          placeholder="Qty"
                          value={restockVal}
                          onChange={(e) => setRestockVal(e.target.value)}
                          className="w-20 rounded-xl bg-stone-950 border border-stone-800 px-3 py-1.5 text-xs text-stone-100 focus:outline-none"
                        />
                        <button
                          onClick={() => onRestock(ing.id, restockVal)}
                          className="rounded-xl bg-amber-500 hover:bg-amber-400 text-stone-950 px-3 py-1.5 text-xs font-semibold cursor-pointer"
                        >
                          Save
                        </button>
                        <button
                          onClick={() => setRestockId(null)}
                          className="text-stone-400 hover:text-stone-200 text-xs cursor-pointer"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <>
                        <button
                          onClick={() => setRestockId(ing.id)}
                          className="flex items-center gap-1 rounded-xl bg-stone-800 hover:bg-stone-700 text-stone-200 px-3 py-1.5 text-xs font-medium border border-stone-700 transition cursor-pointer"
                        >
                          <Plus className="h-3.5 w-3.5 text-amber-400" />
                          <span>Restock</span>
                        </button>
                        <button
                          onClick={() => setIngModal(ing)}
                          className="flex items-center gap-1 rounded-xl bg-stone-800 hover:bg-stone-700 text-stone-200 px-3 py-1.5 text-xs font-medium border border-stone-700 transition cursor-pointer"
                        >
                          <Pencil className="h-3.5 w-3.5 text-amber-400" />
                        </button>
                        <button
                          onClick={() => onDeleteIngredient(ing.id)}
                          className="flex items-center gap-1 rounded-xl bg-red-950/40 hover:bg-red-900/60 text-red-300 px-3 py-1.5 text-xs font-medium border border-red-800/60 transition cursor-pointer"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ===========================================================================
// REPORTS VIEW
// ===========================================================================
function ReportsView({
  sales,
  wasteLogs,
  reportMode,
  setReportMode,
  reportDay,
  setReportDay,
  reportMonth,
  setReportMonth,
  reportRangeStart,
  setReportRangeStart,
  reportRangeEnd,
  setReportRangeEnd,
}) {
  const filteredSales = useMemo(() => {
    return sales.filter((s) => {
      if (s.voided) return false;
      const dKey = dateKey(s.timestamp);
      const mKey = monthKey(s.timestamp);
      if (reportMode === "day") return dKey === reportDay;
      if (reportMode === "month") return mKey === reportMonth;
      if (reportMode === "range") return dKey >= reportRangeStart && dKey <= reportRangeEnd;
      return true;
    });
  }, [sales, reportMode, reportDay, reportMonth, reportRangeStart, reportRangeEnd]);

  const filteredWaste = useMemo(() => {
    return wasteLogs.filter((w) => {
      const dKey = dateKey(w.timestamp);
      const mKey = monthKey(w.timestamp);
      if (reportMode === "day") return dKey === reportDay;
      if (reportMode === "month") return mKey === reportMonth;
      if (reportMode === "range") return dKey >= reportRangeStart && dKey <= reportRangeEnd;
      return true;
    });
  }, [wasteLogs, reportMode, reportDay, reportMonth, reportRangeStart, reportRangeEnd]);

  const totalRevenue = filteredSales.reduce((s, x) => s + x.total, 0);
  const totalCash = filteredSales.reduce((s, x) => s + saleCashAmount(x), 0);
  const totalOnline = filteredSales.reduce((s, x) => s + saleOnlineAmount(x), 0);
  const totalWasteCost = filteredWaste.reduce((s, w) => s + (w.cost || 0), 0);

  // Best selling items
  const itemCounts = useMemo(() => {
    const map = {};
    for (const s of filteredSales) {
      for (const item of s.items) {
        if (itemIsVoided(s, item)) continue;
        map[item.name] = (map[item.name] || 0) + item.qty;
      }
    }
    return Object.entries(map)
      .map(([name, qty]) => ({ name, qty }))
      .sort((a, b) => b.qty - a.qty);
  }, [filteredSales]);

  // Chart data (by day)
  const chartData = useMemo(() => {
    const map = {};
    for (const s of filteredSales) {
      const d = dateKey(s.timestamp);
      map[d] = (map[d] || 0) + s.total;
    }
    return Object.entries(map)
      .map(([date, total]) => ({ date: fmtDay(date), total }))
      .sort((a, b) => new Date(a.date) - new Date(b.date));
  }, [filteredSales]);

  return (
    <div className="flex h-full w-full flex-col overflow-y-auto bg-stone-950 p-6 space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-stone-100">Financial Reports & Analytics</h2>
          <p className="text-xs text-stone-400">Analyze sales performance, payment methods, waste costs, and top items.</p>
        </div>

        {/* Report Period Filter Controls */}
        <div className="flex items-center gap-2 bg-stone-900 p-1.5 rounded-2xl border border-stone-800">
          <button
            onClick={() => setReportMode("day")}
            className={`rounded-xl px-3.5 py-1.5 text-xs font-semibold transition cursor-pointer ${
              reportMode === "day" ? "bg-amber-500 text-stone-950 shadow" : "text-stone-400 hover:text-stone-200"
            }`}
          >
            Day
          </button>
          <button
            onClick={() => setReportMode("month")}
            className={`rounded-xl px-3.5 py-1.5 text-xs font-semibold transition cursor-pointer ${
              reportMode === "month" ? "bg-amber-500 text-stone-950 shadow" : "text-stone-400 hover:text-stone-200"
            }`}
          >
            Month
          </button>
          <button
            onClick={() => setReportMode("range")}
            className={`rounded-xl px-3.5 py-1.5 text-xs font-semibold transition cursor-pointer ${
              reportMode === "range" ? "bg-amber-500 text-stone-950 shadow" : "text-stone-400 hover:text-stone-200"
            }`}
          >
            Range
          </button>
        </div>
      </div>

      {/* Date Picker Control depending on mode */}
      <div className="flex items-center gap-3 bg-stone-900 border border-stone-800 p-4 rounded-2xl">
        {reportMode === "day" && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-stone-400">Select Date:</span>
            <input
              type="date"
              value={reportDay}
              onChange={(e) => setReportDay(e.target.value)}
              className="rounded-xl bg-stone-950 border border-stone-800 px-3 py-1.5 text-xs text-stone-100 focus:outline-none"
            />
          </div>
        )}
        {reportMode === "month" && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-stone-400">Select Month:</span>
            <input
              type="month"
              value={reportMonth}
              onChange={(e) => setReportMonth(e.target.value)}
              className="rounded-xl bg-stone-950 border border-stone-800 px-3 py-1.5 text-xs text-stone-100 focus:outline-none"
            />
          </div>
        )}
        {reportMode === "range" && (
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-stone-400">From:</span>
              <input
                type="date"
                value={reportRangeStart}
                onChange={(e) => setReportRangeStart(e.target.value)}
                className="rounded-xl bg-stone-950 border border-stone-800 px-3 py-1.5 text-xs text-stone-100 focus:outline-none"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-stone-400">To:</span>
              <input
                type="date"
                value={reportRangeEnd}
                onChange={(e) => setReportRangeEnd(e.target.value)}
                className="rounded-xl bg-stone-950 border border-stone-800 px-3 py-1.5 text-xs text-stone-100 focus:outline-none"
              />
            </div>
          </div>
        )}
      </div>

      {/* KPI Metric Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="rounded-2xl bg-stone-900 border border-stone-800 p-5">
          <span className="text-xs text-stone-400 uppercase tracking-wider">Total Revenue</span>
          <h3 className="text-2xl font-bold text-amber-400 mt-1">{money(totalRevenue)}</h3>
          <p className="text-xs text-stone-500 mt-1">{filteredSales.length} completed orders</p>
        </div>
        <div className="rounded-2xl bg-stone-900 border border-stone-800 p-5">
          <span className="text-xs text-stone-400 uppercase tracking-wider">Cash Sales</span>
          <h3 className="text-2xl font-bold text-stone-100 mt-1">{money(totalCash)}</h3>
          <p className="text-xs text-stone-500 mt-1">Physical drawer receipts</p>
        </div>
        <div className="rounded-2xl bg-stone-900 border border-stone-800 p-5">
          <span className="text-xs text-stone-400 uppercase tracking-wider">Online / GCash</span>
          <h3 className="text-2xl font-bold text-stone-100 mt-1">{money(totalOnline)}</h3>
          <p className="text-xs text-stone-500 mt-1">Digital payments</p>
        </div>
        <div className="rounded-2xl bg-stone-900 border border-stone-800 p-5">
          <span className="text-xs text-stone-400 uppercase tracking-wider">Waste Cost</span>
          <h3 className="text-2xl font-bold text-red-400 mt-1">{money(totalWasteCost)}</h3>
          <p className="text-xs text-stone-500 mt-1">{filteredWaste.length} waste entries</p>
        </div>
      </div>

      {/* Chart Section */}
      {chartData.length > 0 && (
        <div className="rounded-2xl bg-stone-900 border border-stone-800 p-5">
          <h3 className="text-sm font-bold text-stone-100 mb-4">Revenue Trend</h3>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#292524" />
                <XAxis dataKey="date" stroke="#78716c" textAnchor="end" fontSize={11} />
                <YAxis stroke="#78716c" fontSize={11} />
                <Tooltip contentStyle={{ backgroundColor: "#1c1917", borderColor: "#292524", borderRadius: 12, color: "#f5f5f4" }} />
                <Bar dataKey="total" fill="#f59e0b" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Top Selling Items & Waste Logs */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="rounded-2xl bg-stone-900 border border-stone-800 p-5">
          <h3 className="text-sm font-bold text-stone-100 mb-4">Top Selling Items</h3>
          {itemCounts.length === 0 ? (
            <p className="text-xs text-stone-500">No sales recorded for this period.</p>
          ) : (
            <div className="space-y-3">
              {itemCounts.slice(0, 6).map((item, idx) => (
                <div key={item.name} className="flex items-center justify-between text-xs border-b border-stone-800/60 pb-2">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-stone-500 w-4">{idx + 1}.</span>
                    <span className="text-stone-200 font-medium">{item.name}</span>
                  </div>
                  <span className="font-bold text-amber-400">{item.qty} sold</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-2xl bg-stone-900 border border-stone-800 p-5">
          <h3 className="text-sm font-bold text-stone-100 mb-4">Waste Log Summary</h3>
          {filteredWaste.length === 0 ? (
            <p className="text-xs text-stone-500">No waste recorded for this period.</p>
          ) : (
            <div className="space-y-3 max-h-60 overflow-y-auto">
              {filteredWaste.map((w) => (
                <div key={w.id} className="flex items-center justify-between text-xs border-b border-stone-800/60 pb-2">
                  <div>
                    <span className="font-semibold text-stone-200">{w.ingredientName || w.productName}</span>
                    <p className="text-[11px] text-stone-400">{w.amount} {w.unit} • {w.reason} {w.note ? `(${w.note})` : ""}</p>
                  </div>
                  <span className="font-bold text-red-400">{money(w.cost)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ===========================================================================
// SALES HISTORY VIEW
// ===========================================================================
function SalesHistoryView({
  sales,
  historyMode,
  setHistoryMode,
  historyDay,
  setHistoryDay,
  historyRangeStart,
  setHistoryRangeStart,
  historyRangeEnd,
  setHistoryRangeEnd,
  onVoidSale,
  onRestoreSale,
  onInspectSale,
  employees,
  onVoidItem,
}) {
  const [search, setSearch] = useState("");
  const [selectedPin, setSelectedPin] = useState("");
  const [targetItemForVoid, setTargetItemForVoid] = useState(null); // {saleId, itemIdx, name}
  const [voidItemReason, setVoidItemReason] = useState("");

  const filteredSales = useMemo(() => {
    return sales.filter((s) => {
      const dKey = dateKey(s.timestamp);
      const matchPeriod =
        historyMode === "day"
          ? dKey === historyDay
          : historyMode === "range"
          ? dKey >= historyRangeStart && dKey <= historyRangeEnd
          : true;
      const matchSearch =
        s.orderNo.toString().includes(search) ||
        s.employeeName.toLowerCase().includes(search.toLowerCase());
      return matchPeriod && matchSearch;
    });
  }, [sales, historyMode, historyDay, historyRangeStart, historyRangeEnd, search]);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-stone-950 p-6 space-y-4">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-stone-100">Sales History & Receipts</h2>
          <p className="text-xs text-stone-400">View past orders, inspect receipts, void orders, or void individual items with manager approval.</p>
        </div>

        {/* Filter Controls */}
        <div className="flex items-center gap-3">
          <input
            type="text"
            placeholder="Search order # or staff..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="rounded-xl bg-stone-900 border border-stone-800 px-3.5 py-2 text-xs text-stone-100 placeholder-stone-500 focus:outline-none"
          />
          <div className="flex items-center gap-1 bg-stone-900 p-1 rounded-xl border border-stone-800">
            <button
              onClick={() => setHistoryMode("day")}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition cursor-pointer ${
                historyMode === "day" ? "bg-amber-500 text-stone-950 shadow" : "text-stone-400"
              }`}
            >
              Day
            </button>
            <button
              onClick={() => setHistoryMode("range")}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition cursor-pointer ${
                historyMode === "range" ? "bg-amber-500 text-stone-950 shadow" : "text-stone-400"
              }`}
            >
              Range
            </button>
            <button
              onClick={() => setHistoryMode("all")}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition cursor-pointer ${
                historyMode === "all" ? "bg-amber-500 text-stone-950 shadow" : "text-stone-400"
              }`}
            >
              All
            </button>
          </div>
        </div>
      </div>

      {historyMode === "day" && (
        <div className="flex items-center gap-2 bg-stone-900 border border-stone-800 p-3 rounded-2xl w-fit">
          <span className="text-xs text-stone-400">Date:</span>
          <input
            type="date"
            value={historyDay}
            onChange={(e) => setHistoryDay(e.target.value)}
            className="rounded-xl bg-stone-950 border border-stone-800 px-3 py-1 text-xs text-stone-100 focus:outline-none"
          />
        </div>
      )}

      {historyMode === "range" && (
        <div className="flex items-center gap-3 bg-stone-900 border border-stone-800 p-3 rounded-2xl w-fit">
          <div className="flex items-center gap-2">
            <span className="text-xs text-stone-400">From:</span>
            <input
              type="date"
              value={historyRangeStart}
              onChange={(e) => setHistoryRangeStart(e.target.value)}
              className="rounded-xl bg-stone-950 border border-stone-800 px-3 py-1 text-xs text-stone-100 focus:outline-none"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-stone-400">To:</span>
            <input
              type="date"
              value={historyRangeEnd}
              onChange={(e) => setHistoryRangeEnd(e.target.value)}
              className="rounded-xl bg-stone-950 border border-stone-800 px-3 py-1 text-xs text-stone-100 focus:outline-none"
            />
          </div>
        </div>
      )}

      {/* Sales List Table */}
      <div className="flex-1 overflow-y-auto rounded-2xl bg-stone-900 border border-stone-800">
        {filteredSales.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-stone-500">
            <HistoryIcon className="h-10 w-10 mb-2 opacity-30" />
            <p className="text-sm">No sales found for this filter</p>
          </div>
        ) : (
          <div className="divide-y divide-stone-800">
            {filteredSales.map((s) => (
              <div key={s.id} className={`flex items-center justify-between p-4 hover:bg-stone-800/40 transition ${s.voided ? 'opacity-60 bg-red-950/10' : ''}`}>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-stone-100">Order #{s.orderNo}</span>
                    {s.voided ? (
                      <span className="rounded bg-red-950 border border-red-800 px-2 py-0.5 text-[10px] font-semibold text-red-400">Voided</span>
                    ) : (
                      <span className="rounded bg-emerald-950 border border-emerald-800 px-2 py-0.5 text-[10px] font-semibold text-emerald-400 uppercase">{s.paymentMethod}</span>
                    )}
                  </div>
                  <p className="text-xs text-stone-400 mt-1">
                    {new Date(s.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} • Staff: <span className="text-stone-300 font-medium">{s.employeeName}</span> • Items: {s.items.reduce((sum, i) => sum + i.qty, 0)}
                  </p>
                </div>

                <div className="flex items-center gap-3">
                  <div className="text-right">
                    <span className="text-sm font-bold text-amber-400">{money(s.total)}</span>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => onInspectSale(s)}
                      className="flex items-center gap-1 rounded-xl bg-stone-800 hover:bg-stone-700 text-stone-200 px-3 py-1.5 text-xs font-medium border border-stone-700 transition cursor-pointer"
                    >
                      <Eye className="h-3.5 w-3.5 text-amber-400" />
                      <span>View</span>
                    </button>
                    {s.voided ? (
                      <button
                        onClick={() => onRestoreSale(s)}
                        className="flex items-center gap-1 rounded-xl bg-emerald-950/40 hover:bg-emerald-900/60 text-emerald-300 px-3 py-1.5 text-xs font-medium border border-emerald-800/60 transition cursor-pointer"
                      >
                        <Undo2 className="h-3.5 w-3.5" />
                        <span>Restore</span>
                      </button>
                    ) : (
                      <button
                        onClick={() => onVoidSale(s)}
                        className="flex items-center gap-1 rounded-xl bg-red-950/40 hover:bg-red-900/60 text-red-300 px-3 py-1.5 text-xs font-medium border border-red-800/60 transition cursor-pointer"
                      >
                        <Ban className="h-3.5 w-3.5" />
                        <span>Void</span>
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ===========================================================================
// SETTINGS VIEW
// ===========================================================================
function SettingsView({
  account,
  onUpdateField,
  currencyCode,
  onChangeCurrency,
  employees,
  onAddEmployee,
  onUpdateEmployee,
  onDeleteEmployee,
  shifts,
  onOpenShift,
  onCloseShift,
  activeShiftInfo,
  onResetData,
  supportEmail,
  paymongoLink,
  onShowUpgrade,
}) {
  const [businessNameVal, setBusinessNameVal] = useState(account?.businessName || "");
  const [emailVal, setEmailVal] = useState(account?.email || "");
  const [passVal, setPassVal] = useState("");

  const [empName, setEmpName] = useState("");
  const [empRole, setEmpRole] = useState("staff");
  const [empPin, setEmpPin] = useState("");
  const [editingEmpId, setEditingEmpId] = useState(null);

  const [openingFloatInput, setOpeningFloatInput] = useState("");
  const [closingCashInput, setClosingCashInput] = useState("");
  const [closingNoteInput, setClosingNoteInput] = useState("");

  return (
    <div className="flex h-full w-full flex-col overflow-y-auto bg-stone-950 p-6 space-y-6">
      <div>
        <h2 className="text-xl font-bold text-stone-100">Settings & Configuration</h2>
        <p className="text-xs text-stone-400">Manage business profile, currency, staff accounts, cash drawers, and subscription.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Business Profile & Account */}
        <div className="rounded-2xl bg-stone-900 border border-stone-800 p-5 space-y-4">
          <h3 className="text-sm font-bold text-stone-100 flex items-center gap-2">
            <Store className="h-4 w-4 text-amber-400" /> Business Profile & Login
          </h3>

          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-stone-300 mb-1">Business Name</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={businessNameVal}
                  onChange={(e) => setBusinessNameVal(e.target.value)}
                  className="flex-1 rounded-xl bg-stone-950 border border-stone-800 px-3 py-2 text-xs text-stone-100 focus:outline-none"
                />
                <button
                  onClick={() => onUpdateField("businessName", businessNameVal)}
                  className="rounded-xl bg-stone-800 hover:bg-stone-700 text-stone-200 px-4 py-2 text-xs font-semibold cursor-pointer"
                >
                  Save
                </button>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-stone-300 mb-1">Account Email</label>
              <div className="flex gap-2">
                <input
                  type="email"
                  value={emailVal}
                  onChange={(e) => setEmailVal(e.target.value)}
                  className="flex-1 rounded-xl bg-stone-950 border border-stone-800 px-3 py-2 text-xs text-stone-100 focus:outline-none"
                />
                <button
                  onClick={() => onUpdateField("email", emailVal)}
                  className="rounded-xl bg-stone-800 hover:bg-stone-700 text-stone-200 px-4 py-2 text-xs font-semibold cursor-pointer"
                >
                  Update
                </button>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-stone-300 mb-1">New Password</label>
              <div className="flex gap-2">
                <input
                  type="password"
                  placeholder="••••••••"
                  value={passVal}
                  onChange={(e) => setPassVal(e.target.value)}
                  className="flex-1 rounded-xl bg-stone-950 border border-stone-800 px-3.5 py-2 text-xs text-stone-100 focus:outline-none"
                />
                <button
                  onClick={async () => {
                    const ok = await onUpdateField("password", passVal);
                    if (ok) setPassVal("");
                  }}
                  className="rounded-xl bg-stone-800 hover:bg-stone-700 text-stone-200 px-4 py-2 text-xs font-semibold cursor-pointer"
                >
                  Change
                </button>
              </div>
            </div>

            {/* Currency Selector */}
            <div>
              <label className="block text-xs font-medium text-stone-300 mb-1">Currency</label>
              <select
                value={currencyCode}
                onChange={(e) => onChangeCurrency(e.target.value)}
                className="w-full rounded-xl bg-stone-950 border border-stone-800 px-3.5 py-2 text-xs text-stone-100 focus:outline-none"
              >
                {CURRENCIES.map((c) => (
                  <option key={c.code} value={c.code}>{c.label}</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Subscription & Referral Program */}
        <div className="rounded-2xl bg-stone-900 border border-stone-800 p-5 space-y-4">
          <h3 className="text-sm font-bold text-stone-100 flex items-center gap-2">
            <Coins className="h-4 w-4 text-amber-400" /> Subscription & Referrals
          </h3>

          <div className="rounded-xl bg-stone-950 border border-stone-800 p-4 space-y-3">
            <div className="flex justify-between items-center text-xs">
              <span className="text-stone-400">Status</span>
              <span className="font-bold uppercase text-amber-400">{account?.subscriptionStatus || "trial"}</span>
            </div>
            <div className="flex justify-between items-center text-xs">
              <span className="text-stone-400">Your Referral Code</span>
              <span className="font-mono font-bold text-stone-100 bg-stone-900 px-2.5 py-1 rounded border border-stone-800">
                {account?.id ? `OP-${account.id.slice(0, 6).toUpperCase()}` : "OP-MAIN"}
              </span>
            </div>
            <div className="flex justify-between items-center text-xs">
              <span className="text-stone-400">Referral Rewards Earned</span>
              <span className="font-bold text-emerald-400">{money(account?.rewardCredits || 0)}</span>
            </div>

            <button
              onClick={onShowUpgrade}
              className="w-full rounded-xl bg-amber-500 hover:bg-amber-400 text-stone-950 font-semibold py-2.5 text-xs shadow transition cursor-pointer"
            >
              Upgrade / Extend Subscription
            </button>
          </div>

          <p className="text-[11px] text-stone-500">
            Support: <a href={`mailto:${supportEmail}`} className="text-stone-400 underline">{supportEmail}</a>
          </p>
        </div>

        {/* Employee & Staff Accounts */}
        <div className="rounded-2xl bg-stone-900 border border-stone-800 p-5 space-y-4">
          <h3 className="text-sm font-bold text-stone-100">Staff & Manager PINs</h3>

          <div className="space-y-3">
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="Staff Name"
                value={empName}
                onChange={(e) => setEmpName(e.target.value)}
                className="flex-1 rounded-xl bg-stone-950 border border-stone-800 px-3 py-2 text-xs text-stone-100 focus:outline-none"
              />
              <select
                value={empRole}
                onChange={(e) => setEmpRole(e.target.value)}
                className="rounded-xl bg-stone-950 border border-stone-800 px-3 py-2 text-xs text-stone-100 focus:outline-none"
              >
                <option value="staff">Staff</option>
                <option value="manager">Manager</option>
              </select>
              <input
                type="password"
                placeholder="PIN"
                value={empPin}
                onChange={(e) => setEmpPin(e.target.value)}
                className="w-20 rounded-xl bg-stone-950 border border-stone-800 px-3 py-2 text-xs text-stone-100 focus:outline-none"
              />
              <button
                onClick={() => {
                  if (!empName.trim()) return;
                  if (editingEmpId) {
                    onUpdateEmployee(editingEmpId, empName, empRole, empPin);
                    setEditingEmpId(null);
                  } else {
                    onAddEmployee(empName, empRole, empPin);
                  }
                  setEmpName("");
                  setEmpPin("");
                }}
                className="rounded-xl bg-amber-500 hover:bg-amber-400 text-stone-950 px-4 py-2 text-xs font-semibold cursor-pointer"
              >
                {editingEmpId ? "Update" : "Add"}
              </button>
            </div>

            <div className="space-y-2 max-h-40 overflow-y-auto">
              {employees.map((e) => (
                <div key={e.id} className="flex items-center justify-between text-xs bg-stone-950 p-2.5 rounded-xl border border-stone-800">
                  <div>
                    <span className="font-bold text-stone-200">{e.name}</span>
                    <span className="ml-2 rounded bg-stone-900 px-2 py-0.5 text-[10px] text-stone-400 capitalize">{e.role}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => {
                        setEditingEmpId(e.id);
                        setEmpName(e.name);
                        setEmpRole(e.role || "staff");
                        setEmpPin(e.pin || "");
                      }}
                      className="text-amber-400 hover:underline"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => onDeleteEmployee(e.id)}
                      className="text-red-400 hover:underline"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Cash Drawer & Shift Management */}
        <div className="rounded-2xl bg-stone-900 border border-stone-800 p-5 space-y-4">
          <h3 className="text-sm font-bold text-stone-100">Cash Drawer & Shifts</h3>

          {activeShiftInfo ? (
            <div className="rounded-xl bg-stone-950 border border-stone-800 p-4 space-y-3">
              <div className="flex justify-between items-center text-xs">
                <span className="text-stone-400">Shift Status</span>
                <span className="font-bold text-emerald-400">OPEN</span>
              </div>
              <div className="flex justify-between items-center text-xs">
                <span className="text-stone-400">Opened By</span>
                <span className="text-stone-200 font-medium">{activeShiftInfo.openedByName}</span>
              </div>
              <div className="flex justify-between items-center text-xs">
                <span className="text-stone-400">Opening Float</span>
                <span className="text-stone-200">{money(activeShiftInfo.openingFloat)}</span>
              </div>
              <div className="flex justify-between items-center text-xs">
                <span className="text-stone-400">Expected Cash in Drawer</span>
                <span className="font-bold text-amber-400">{money(activeShiftInfo.expectedCash)}</span>
              </div>

              <div className="border-t border-stone-800 pt-3 space-y-2">
                <input
                  type="number"
                  placeholder="Counted cash in drawer"
                  value={closingCashInput}
                  onChange={(e) => setClosingCashInput(e.target.value)}
                  className="w-full rounded-xl bg-stone-900 border border-stone-800 px-3 py-2 text-xs text-stone-100 focus:outline-none"
                />
                <input
                  type="text"
                  placeholder="Closing note / reason for variance"
                  value={closingNoteInput}
                  onChange={(e) => setClosingNoteInput(e.target.value)}
                  className="w-full rounded-xl bg-stone-900 border border-stone-800 px-3 py-2 text-xs text-stone-100 focus:outline-none"
                />
                <button
                  onClick={() => {
                    onCloseShift(closingCashInput, closingNoteInput);
                    setClosingCashInput("");
                    setClosingNoteInput("");
                  }}
                  className="w-full rounded-xl bg-red-950 hover:bg-red-900 text-red-300 border border-red-800 font-semibold py-2.5 text-xs transition cursor-pointer"
                >
                  Close Shift & Count Drawer
                </button>
              </div>
            </div>
          ) : (
            <div className="rounded-xl bg-stone-950 border border-stone-800 p-4 space-y-3">
              <p className="text-xs text-stone-400">No shift is currently open. Enter opening float to start:</p>
              <input
                type="number"
                placeholder="Opening float amount (e.g. 1000)"
                value={openingFloatInput}
                onChange={(e) => setOpeningFloatInput(e.target.value)}
                className="w-full rounded-xl bg-stone-900 border border-stone-800 px-3.5 py-2.5 text-xs text-stone-100 focus:outline-none"
              />
              <button
                onClick={() => {
                  onOpenShift(openingFloatInput);
                  setOpeningFloatInput("");
                }}
                className="w-full rounded-xl bg-amber-500 hover:bg-amber-400 text-stone-950 font-semibold py-2.5 text-xs transition cursor-pointer"
              >
                Open Shift
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Reset Data Button */}
      <div className="border-t border-stone-800 pt-6 flex justify-end">
        <button
          onClick={onResetData}
          className="rounded-xl bg-red-950/40 hover:bg-red-900/60 text-red-300 border border-red-800 px-4 py-2 text-xs font-semibold transition cursor-pointer"
        >
          Reset All Local POS Data
        </button>
      </div>
    </div>
  );
}

// ===========================================================================
// MODALS
// ===========================================================================

function ReceiptModal({ receipt, onClose, businessName }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-sm rounded-3xl bg-stone-900 border border-stone-800 p-6 shadow-2xl relative text-stone-100">
        <button onClick={onClose} className="absolute top-4 right-4 text-stone-400 hover:text-stone-200 cursor-pointer">
          <X className="h-5 w-5" />
        </button>

        <div className="flex flex-col items-center text-center mb-4">
          <h3 className="text-base font-bold">{businessName}</h3>
          <p className="text-xs text-stone-400">Order #{receipt.orderNo}</p>
          <p className="text-[11px] text-stone-500">{new Date(receipt.timestamp).toLocaleString()}</p>
        </div>

        <div className="border-t border-b border-stone-800 py-3 my-3 space-y-2 max-h-48 overflow-y-auto">
          {receipt.items.map((item, idx) => (
            <div key={idx} className="flex justify-between text-xs">
              <span className="text-stone-300">{item.qty}x {item.name}</span>
              <span className="text-stone-100 font-medium">{money(item.subtotal)}</span>
            </div>
          ))}
        </div>

        <div className="space-y-1.5 text-xs">
          <div className="flex justify-between text-stone-400">
            <span>Subtotal</span>
            <span>{money(receipt.subtotal)}</span>
          </div>
          {receipt.discountAmount > 0 && (
            <div className="flex justify-between text-emerald-400">
              <span>Discount</span>
              <span>-{money(receipt.discountAmount)}</span>
            </div>
          )}
          <div className="flex justify-between text-sm font-bold text-stone-100 pt-1 border-t border-stone-800">
            <span>Total</span>
            <span className="text-amber-400">{money(receipt.total)}</span>
          </div>
          {receipt.paymentMethod === "cash" && (
            <>
              <div className="flex justify-between text-stone-400">
                <span>Cash Tendered</span>
                <span>{money(receipt.cashReceived)}</span>
              </div>
              <div className="flex justify-between text-emerald-400">
                <span>Change</span>
                <span>{money(receipt.change)}</span>
              </div>
            </>
          )}
        </div>

        <div className="mt-6 flex justify-center">
          <button
            onClick={onClose}
            className="w-full rounded-xl bg-amber-500 hover:bg-amber-400 text-stone-950 font-semibold py-2.5 text-xs shadow transition cursor-pointer"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function IngredientModal({ ingredient, onClose, onSave }) {
  const [name, setName] = useState(ingredient?.name || "");
  const [unit, setUnit] = useState(ingredient?.unit || "g");
  const [stock, setStock] = useState(ingredient?.stock ?? 1000);
  const [low, setLow] = useState(ingredient?.low ?? 100);
  const [cost, setCost] = useState(ingredient?.cost ?? 0.1);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-3xl bg-stone-900 border border-stone-800 p-6 shadow-2xl relative text-stone-100">
        <button onClick={onClose} className="absolute top-4 right-4 text-stone-400 hover:text-stone-200 cursor-pointer">
          <X className="h-5 w-5" />
        </button>

        <h3 className="text-lg font-bold mb-4">{ingredient ? "Edit Ingredient" : "New Ingredient"}</h3>

        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-stone-300 mb-1">Ingredient Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-xl bg-stone-950 border border-stone-800 px-3.5 py-2 text-xs text-stone-100 focus:outline-none"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-stone-300 mb-1">Unit</label>
              <select
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                className="w-full rounded-xl bg-stone-950 border border-stone-800 px-3.5 py-2 text-xs text-stone-100 focus:outline-none"
              >
                {UNITS.map((u) => (
                  <option key={u.id} value={u.id}>{u.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-300 mb-1">Unit Cost</label>
              <input
                type="number"
                step="0.01"
                value={cost}
                onChange={(e) => setCost(e.target.value)}
                className="w-full rounded-xl bg-stone-950 border border-stone-800 px-3.5 py-2 text-xs text-stone-100 focus:outline-none"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-stone-300 mb-1">Initial Stock</label>
              <input
                type="number"
                value={stock}
                onChange={(e) => setStock(e.target.value)}
                className="w-full rounded-xl bg-stone-950 border border-stone-800 px-3.5 py-2 text-xs text-stone-100 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-300 mb-1">Low Stock Alert Level</label>
              <input
                type="number"
                value={low}
                onChange={(e) => setLow(e.target.value)}
                className="w-full rounded-xl bg-stone-950 border border-stone-800 px-3.5 py-2 text-xs text-stone-100 focus:outline-none"
              />
            </div>
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 rounded-xl bg-stone-800 text-stone-200 text-xs font-medium cursor-pointer">Cancel</button>
          <button
            onClick={() => {
              if (!name.trim()) return;
              onSave({
                id: ingredient?.id || uid("ing"),
                name: name.trim(),
                unit,
                stock: Number(stock) || 0,
                low: Number(low) || 0,
                cost: Number(cost) || 0,
              });
            }}
            className="px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-stone-950 text-xs font-semibold cursor-pointer"
          >
            Save Ingredient
          </button>
        </div>
      </div>
    </div>
  );
}

function ProductModal({ product, categories, ingredients, onClose, onSave }) {
  const [name, setName] = useState(product?.name || "");
  const [category, setCategory] = useState(product?.category || categories[0]?.id || "drink");
  const [price, setPrice] = useState(product?.price || 100);
  const [recipe, setRecipe] = useState(product?.recipe || []); // [{ingredientId, amount}]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg rounded-3xl bg-stone-900 border border-stone-800 p-6 shadow-2xl relative text-stone-100 max-h-[90vh] flex flex-col">
        <button onClick={onClose} className="absolute top-4 right-4 text-stone-400 hover:text-stone-200 cursor-pointer">
          <X className="h-5 w-5" />
        </button>

        <h3 className="text-lg font-bold mb-4">{product ? "Edit Product" : "New Product"}</h3>

        <div className="space-y-4 overflow-y-auto flex-1 pr-1">
          <div>
            <label className="block text-xs font-medium text-stone-300 mb-1">Product Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-xl bg-stone-950 border border-stone-800 px-3.5 py-2 text-xs text-stone-100 focus:outline-none"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-stone-300 mb-1">Category</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full rounded-xl bg-stone-950 border border-stone-800 px-3.5 py-2 text-xs text-stone-100 focus:outline-none capitalize"
              >
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-300 mb-1">Price</label>
              <input
                type="number"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                className="w-full rounded-xl bg-stone-950 border border-stone-800 px-3.5 py-2 text-xs text-stone-100 focus:outline-none"
              />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-medium text-stone-300">Recipe / Ingredient Deductions</label>
              <button
                onClick={() => setRecipe([...recipe, { ingredientId: ingredients[0]?.id || "", amount: 1 }])}
                className="text-xs text-amber-400 hover:underline flex items-center gap-1 cursor-pointer"
              >
                <Plus className="h-3 w-3" /> Add ingredient
              </button>
            </div>

            <div className="space-y-2">
              {recipe.map((r, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <select
                    value={r.ingredientId}
                    onChange={(e) => {
                      const next = [...recipe];
                      next[idx].ingredientId = e.target.value;
                      setRecipe(next);
                    }}
                    className="flex-1 rounded-xl bg-stone-950 border border-stone-800 px-3 py-1.5 text-xs text-stone-100 focus:outline-none"
                  >
                    {ingredients.map((i) => (
                      <option key={i.id} value={i.id}>{i.name} ({i.unit})</option>
                    ))}
                  </select>
                  <input
                    type="number"
                    placeholder="Amount"
                    value={r.amount}
                    onChange={(e) => {
                      const next = [...recipe];
                      next[idx].amount = Number(e.target.value) || 0;
                      setRecipe(next);
                    }}
                    className="w-24 rounded-xl bg-stone-950 border border-stone-800 px-3 py-1.5 text-xs text-stone-100 focus:outline-none"
                  />
                  <button
                    onClick={() => setRecipe(recipe.filter((_, i) => i !== idx))}
                    className="text-stone-500 hover:text-red-400 cursor-pointer"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-3 pt-3 border-t border-stone-800">
          <button onClick={onClose} className="px-4 py-2 rounded-xl bg-stone-800 text-stone-200 text-xs font-medium cursor-pointer">Cancel</button>
          <button
            onClick={() => {
              if (!name.trim()) return;
              onSave({
                id: product?.id || uid("prod"),
                name: name.trim(),
                category,
                price: Number(price) || 0,
                recipe,
              });
            }}
            className="px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-stone-950 text-xs font-semibold cursor-pointer"
          >
            Save Product
          </button>
        </div>
      </div>
    </div>
  );
}

function CategoryModal({ onClose, onSave }) {
  const [name, setName] = useState("");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-sm rounded-3xl bg-stone-900 border border-stone-800 p-6 shadow-2xl relative text-stone-100">
        <button onClick={onClose} className="absolute top-4 right-4 text-stone-400 hover:text-stone-200 cursor-pointer">
          <X className="h-5 w-5" />
        </button>

        <h3 className="text-lg font-bold mb-4">Add Category</h3>

        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-stone-300 mb-1">Category Name</label>
            <input
              type="text"
              placeholder="e.g. Pastries"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-xl bg-stone-950 border border-stone-800 px-3.5 py-2 text-xs text-stone-100 focus:outline-none"
            />
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 rounded-xl bg-stone-800 text-stone-200 text-xs font-medium cursor-pointer">Cancel</button>
          <button
            onClick={() => onSave(name)}
            className="px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-stone-950 text-xs font-semibold cursor-pointer"
          >
            Add Category
          </button>
        </div>
      </div>
    </div>
  );
}

function VoidModal({ sale, onClose, onConfirm }) {
  const [reason, setReason] = useState("");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-sm rounded-3xl bg-stone-900 border border-stone-800 p-6 shadow-2xl relative text-stone-100">
        <button onClick={onClose} className="absolute top-4 right-4 text-stone-400 hover:text-stone-200 cursor-pointer">
          <X className="h-5 w-5" />
        </button>

        <h3 className="text-lg font-bold text-red-400 mb-2">Void Order #{sale.orderNo}</h3>
        <p className="text-xs text-stone-400 mb-4">This will return ingredients to stock and mark the sale as voided.</p>

        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-stone-300 mb-1">Reason for Voiding</label>
            <input
              type="text"
              placeholder="e.g. Customer cancelled / Wrong order"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full rounded-xl bg-stone-950 border border-stone-800 px-3.5 py-2 text-xs text-stone-100 focus:outline-none"
            />
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 rounded-xl bg-stone-800 text-stone-200 text-xs font-medium cursor-pointer">Cancel</button>
          <button
            onClick={() => onConfirm(reason || "Customer cancelled")}
            className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-semibold cursor-pointer"
          >
            Confirm Void
          </button>
        </div>
      </div>
    </div>
  );
}

function RestoreModal({ sale, employees, onClose, onConfirm }) {
  const [pin, setPin] = useState("");
  const managers = employees.filter((e) => e.role === "manager");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-sm rounded-3xl bg-stone-900 border border-stone-800 p-6 shadow-2xl relative text-stone-100">
        <button onClick={onClose} className="absolute top-4 right-4 text-stone-400 hover:text-stone-200 cursor-pointer">
          <X className="h-5 w-5" />
        </button>

        <h3 className="text-lg font-bold text-emerald-400 mb-2">Restore Order #{sale.orderNo}</h3>
        <p className="text-xs text-stone-400 mb-4">Restoring a voided order re-deducts inventory stock. Manager PIN required.</p>

        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-stone-300 mb-1">Manager PIN</label>
            <input
              type="password"
              placeholder="Enter PIN"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              className="w-full rounded-xl bg-stone-950 border border-stone-800 px-3.5 py-2 text-xs text-stone-100 focus:outline-none"
            />
            {managers.length === 0 && (
              <p className="text-[11px] text-amber-400 mt-1">Note: No managers defined. Any PIN or check settings.</p>
            )}
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 rounded-xl bg-stone-800 text-stone-200 text-xs font-medium cursor-pointer">Cancel</button>
          <button
            onClick={() => onConfirm(pin)}
            className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold cursor-pointer"
          >
            Authorize & Restore
          </button>
        </div>
      </div>
    </div>
  );
}

function SaleDetailModal({ sale, onClose, employees, onVoidItem }) {
  const [voidingIdx, setVoidingIdx] = useState(null);
  const [reason, setReason] = useState("");
  const [pin, setPin] = useState("");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-3xl bg-stone-900 border border-stone-800 p-6 shadow-2xl relative text-stone-100 max-h-[90vh] flex flex-col">
        <button onClick={onClose} className="absolute top-4 right-4 text-stone-400 hover:text-stone-200 cursor-pointer">
          <X className="h-5 w-5" />
        </button>

        <div className="flex items-center justify-between mb-4 border-b border-stone-800 pb-3">
          <div>
            <h3 className="text-base font-bold">Order #{sale.orderNo}</h3>
            <p className="text-xs text-stone-400">{new Date(sale.timestamp).toLocaleString()} • Staff: {sale.employeeName}</p>
          </div>
          <span className="text-sm font-bold text-amber-400">{money(sale.total)}</span>
        </div>

        <div className="space-y-3 overflow-y-auto flex-1 mb-4 pr-1">
          {sale.items.map((item, idx) => {
            const isVoid = item.voided === true;
            return (
              <div key={idx} className={`flex items-center justify-between p-3 rounded-xl border ${isVoid ? 'bg-red-950/20 border-red-900/40 opacity-60' : 'bg-stone-950 border-stone-800'}`}>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-stone-200">{item.qty}x {item.name}</span>
                    {isVoid && <span className="text-[10px] bg-red-950 text-red-400 px-1.5 py-0.5 rounded">Voided</span>}
                  </div>
                  <p className="text-[11px] text-stone-400">{money(item.subtotal)}</p>
                </div>

                {!sale.voided && !isVoid && (
                  <button
                    onClick={() => setVoidingIdx(idx)}
                    className="rounded-lg bg-red-950/40 hover:bg-red-900/60 text-red-300 px-2.5 py-1 text-[11px] font-medium border border-red-800/60 cursor-pointer"
                  >
                    Void Item
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {voidingIdx !== null && (
          <div className="rounded-xl bg-stone-950 border border-stone-800 p-3 space-y-3 mb-4">
            <h4 className="text-xs font-bold text-red-400">Void Item: {sale.items[voidingIdx].name}</h4>
            <input
              type="text"
              placeholder="Reason for voiding item"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full rounded-lg bg-stone-900 border border-stone-800 px-3 py-1.5 text-xs text-stone-100 focus:outline-none"
            />
            <input
              type="password"
              placeholder="Manager PIN"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              className="w-full rounded-lg bg-stone-900 border border-stone-800 px-3 py-1.5 text-xs text-stone-100 focus:outline-none"
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setVoidingIdx(null)} className="px-3 py-1 text-xs text-stone-400 cursor-pointer">Cancel</button>
              <button
                onClick={() => {
                  onVoidItem(sale.id, voidingIdx, reason || "Item voided", pin);
                  setVoidingIdx(null);
                  setReason("");
                  setPin("");
                }}
                className="px-3 py-1 rounded bg-red-600 text-white text-xs font-semibold cursor-pointer"
              >
                Confirm Void Item
              </button>
            </div>
          </div>
        )}

        {sale.paymentProof && (
          <div className="border-t border-stone-800 pt-3">
            <span className="text-xs text-stone-400 block mb-2">Payment Proof Screenshot</span>
            <img src={sale.paymentProof} alt="Receipt proof" className="w-full h-36 object-cover rounded-xl border border-stone-800" />
          </div>
        )}

        <div className="mt-4 flex justify-end">
          <button onClick={onClose} className="px-4 py-2 rounded-xl bg-stone-800 text-stone-200 text-xs font-medium cursor-pointer">Close</button>
        </div>
      </div>
    </div>
  );
}

function WasteModal({ catalog, onClose, onSave }) {
  const [mode, setMode] = useState("ingredient"); // 'ingredient' | 'product'
  const [ingredientId, setIngredientId] = useState(catalog.ingredients[0]?.id || "");
  const [productId, setProductId] = useState(catalog.products[0]?.id || "");
  const [amount, setAmount] = useState("");
  const [productQty, setProductQty] = useState("1");
  const [reason, setReason] = useState(WASTE_REASONS[0]);
  const [note, setNote] = useState("");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-3xl bg-stone-900 border border-stone-800 p-6 shadow-2xl relative text-stone-100">
        <button onClick={onClose} className="absolute top-4 right-4 text-stone-400 hover:text-stone-200 cursor-pointer">
          <X className="h-5 w-5" />
        </button>

        <h3 className="text-lg font-bold mb-4">Log Waste / Inventory Adjustment</h3>

        <div className="space-y-4">
          <div className="flex gap-2 bg-stone-950 p-1 rounded-xl border border-stone-800">
            <button
              onClick={() => setMode("ingredient")}
              className={`flex-1 rounded-lg py-1.5 text-xs font-semibold transition cursor-pointer ${mode === 'ingredient' ? 'bg-amber-500 text-stone-950' : 'text-stone-400'}`}
            >
              Ingredient Waste
            </button>
            <button
              onClick={() => setMode("product")}
              className={`flex-1 rounded-lg py-1.5 text-xs font-semibold transition cursor-pointer ${mode === 'product' ? 'bg-amber-500 text-stone-950' : 'text-stone-400'}`}
            >
              Product Waste
            </button>
          </div>

          {mode === "ingredient" ? (
            <div>
              <label className="block text-xs font-medium text-stone-300 mb-1">Ingredient</label>
              <select
                value={ingredientId}
                onChange={(e) => setIngredientId(e.target.value)}
                className="w-full rounded-xl bg-stone-950 border border-stone-800 px-3.5 py-2 text-xs text-stone-100 focus:outline-none"
              >
                {catalog.ingredients.map((i) => (
                  <option key={i.id} value={i.id}>{i.name} (Stock: {i.stock} {i.unit})</option>
                ))}
              </select>
            </div>
          ) : (
            <div>
              <label className="block text-xs font-medium text-stone-300 mb-1">Product</label>
              <select
                value={productId}
                onChange={(e) => setProductId(e.target.value)}
                className="w-full rounded-xl bg-stone-950 border border-stone-800 px-3.5 py-2 text-xs text-stone-100 focus:outline-none"
              >
                {catalog.products.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
          )}

          {mode === "ingredient" ? (
            <div>
              <label className="block text-xs font-medium text-stone-300 mb-1">Amount to Waste</label>
              <input
                type="number"
                placeholder="e.g. 200"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-full rounded-xl bg-stone-950 border border-stone-800 px-3.5 py-2 text-xs text-stone-100 focus:outline-none"
              />
            </div>
          ) : (
            <div>
              <label className="block text-xs font-medium text-stone-300 mb-1">Quantity Wasted</label>
              <input
                type="number"
                value={productQty}
                onChange={(e) => setProductQty(e.target.value)}
                className="w-full rounded-xl bg-stone-950 border border-stone-800 px-3.5 py-2 text-xs text-stone-100 focus:outline-none"
              />
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-stone-300 mb-1">Reason</label>
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full rounded-xl bg-stone-950 border border-stone-800 px-3.5 py-2 text-xs text-stone-100 focus:outline-none"
            >
              {WASTE_REASONS.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-stone-300 mb-1">Note (Optional)</label>
            <input
              type="text"
              placeholder="e.g. dropped tray"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="w-full rounded-xl bg-stone-950 border border-stone-800 px-3.5 py-2 text-xs text-stone-100 focus:outline-none"
            />
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 rounded-xl bg-stone-800 text-stone-200 text-xs font-medium cursor-pointer">Cancel</button>
          <button
            onClick={() => onSave({ ingredientId: mode === 'ingredient' ? ingredientId : null, amount, reason, note, productId: mode === 'product' ? productId : null, productQty })}
            className="px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-stone-950 text-xs font-semibold cursor-pointer"
          >
            Log Waste
          </button>
        </div>
      </div>
    </div>
  );
}

function ShiftCloseModal({ activeShiftInfo, onClose, onConfirm }) {
  const [counted, setCounted] = useState("");
  const [note, setNote] = useState("");

  const expected = activeShiftInfo?.expectedCash || 0;
  const countedNum = Number(counted) || 0;
  const variance = countedNum - expected;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-3xl bg-stone-900 border border-stone-800 p-6 shadow-2xl relative text-stone-100">
        <button onClick={onClose} className="absolute top-4 right-4 text-stone-400 hover:text-stone-200 cursor-pointer">
          <X className="h-5 w-5" />
        </button>

        <h3 className="text-lg font-bold mb-2">Close Cash Drawer / Shift</h3>
        <p className="text-xs text-stone-400 mb-4">Count the physical cash in the drawer and record any variance.</p>

        <div className="rounded-xl bg-stone-950 border border-stone-800 p-4 space-y-2 mb-4 text-xs">
          <div className="flex justify-between text-stone-400">
            <span>Opening Float</span>
            <span>{money(activeShiftInfo?.openingFloat)}</span>
          </div>
          <div className="flex justify-between text-stone-400">
            <span>Cash Sales</span>
            <span>{money(activeShiftInfo?.cashSales)}</span>
          </div>
          <div className="flex justify-between font-bold text-stone-200 pt-1 border-t border-stone-800">
            <span>Expected Cash</span>
            <span className="text-amber-400">{money(expected)}</span>
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-stone-300 mb-1">Counted Physical Cash</label>
            <input
              type="number"
              placeholder="0.00"
              value={counted}
              onChange={(e) => setCounted(e.target.value)}
              className="w-full rounded-xl bg-stone-950 border border-stone-800 px-3.5 py-2.5 text-xs text-stone-100 focus:outline-none"
            />
            {counted !== "" && (
              <p className={`text-xs font-semibold mt-1.5 ${variance === 0 ? 'text-emerald-400' : variance > 0 ? 'text-amber-400' : 'text-red-400'}`}>
                Variance: {money(variance)} {variance === 0 ? '(Exact)' : variance > 0 ? '(Over)' : '(Short)'}
              </p>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium text-stone-300 mb-1">Variance Note (if any)</label>
            <input
              type="text"
              placeholder="e.g. gave correct change in coins"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="w-full rounded-xl bg-stone-950 border border-stone-800 px-3.5 py-2 text-xs text-stone-100 focus:outline-none"
            />
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 rounded-xl bg-stone-800 text-stone-200 text-xs font-medium cursor-pointer">Cancel</button>
          <button
            onClick={() => onConfirm(counted, note)}
            className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-semibold cursor-pointer"
          >
            Close Shift
          </button>
        </div>
      </div>
    </div>
  );
}

function HandoffModal({ outgoingShift, incomingEmployee, onClose, onCompleteHandoff }) {
  const [counted, setCounted] = useState("");
  const [note, setNote] = useState("");
  const [newFloat, setNewFloat] = useState("");

  const expected = outgoingShift?.expectedCash || 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-3xl bg-stone-900 border border-stone-800 p-6 shadow-2xl relative text-stone-100">
        <button onClick={onClose} className="absolute top-4 right-4 text-stone-400 hover:text-stone-200 cursor-pointer">
          <X className="h-5 w-5" />
        </button>

        <h3 className="text-lg font-bold mb-1">Shift Handoff</h3>
        <p className="text-xs text-stone-400 mb-4">
          Switching from <span className="text-stone-200 font-medium">{outgoingShift?.openedByName}</span> to <span className="text-amber-400 font-medium">{incomingEmployee?.name}</span>. Count out the outgoing shift first.
        </p>

        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-stone-300 mb-1">Counted Cash for Outgoing Drawer (Expected: {money(expected)})</label>
            <input
              type="number"
              placeholder="0.00"
              value={counted}
              onChange={(e) => setCounted(e.target.value)}
              className="w-full rounded-xl bg-stone-950 border border-stone-800 px-3.5 py-2.5 text-xs text-stone-100 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-300 mb-1">Opening Float for Incoming Shift ({incomingEmployee?.name})</label>
            <input
              type="number"
              placeholder="Float amount"
              value={newFloat}
              onChange={(e) => setNewFloat(e.target.value)}
              className="w-full rounded-xl bg-stone-950 border border-stone-800 px-3.5 py-2.5 text-xs text-stone-100 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-300 mb-1">Handoff Note (Optional)</label>
            <input
              type="text"
              placeholder="e.g. shift change complete"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="w-full rounded-xl bg-stone-950 border border-stone-800 px-3.5 py-2 text-xs text-stone-100 focus:outline-none"
            />
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 rounded-xl bg-stone-800 text-stone-200 text-xs font-medium cursor-pointer">Cancel</button>
          <button
            onClick={() => {
              if (newFloat === "") return;
              onCompleteHandoff(counted, note, newFloat);
            }}
            className="px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-stone-950 text-xs font-semibold cursor-pointer"
          >
            Complete Handoff & Open Shift
          </button>
        </div>
      </div>
    </div>
  );
}
