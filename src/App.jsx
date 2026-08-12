const updateBusinessName = useCallback(async (newName) => {
    if (!authUser) return false;
    try {
      const { error } = await supabase
        .from("businesses")
        .update({ business_name: newName })
        .eq("id", authUser.id);
      if (error) {
        notify("Couldn't update setting: " + error.message, "err");
        return false;
      }
      const next = { ...(accountRef.current || {}), businessName: newName };
      accountRef.current = next;
      setAccount(next);
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
      </main>
    </div>
  );
}
