-- telemetry: graba el recorrido del vehiculo a 20 Hz y lo manda al servidor.
-- /telstart [etiqueta]   /telstop   /telstatus
-- Formato: JSONL, una muestra por linea.

local recording = false
local pending = false
local pausedWarp = false
local warpResume = nil
local timer = nil
local veh = nil
local t0 = 0
local count = 0
local buffer = {}
local CHUNK = 20          -- 1 segundo: si el coche explota, no se pierde todo

local function out(msg)
    outputChatBox("#00C8FF[telemetry]#FFFFFF " .. msg, 255, 255, 255, true)
end

local function flush()
    if #buffer == 0 then return end
    triggerServerEvent("tel:chunk", resourceRoot, table.concat(buffer, "\n"))
    buffer = {}
end

local function num(v, default)
    v = tonumber(v)
    if v == nil then return default end
    return v
end

local function jesc(s)
    s = tostring(s or "")
    s = s:gsub("\\", "\\\\")
    s = s:gsub('"', '\\"')
    return s
end

-- Devuelve el id del mapa del objeto que hay bajo cada "rueda". El id es el
-- atributo id del .map: "object (funturf_law) (37)". Sirve para saber
-- exactamente que losa/pieza esta pisando el Infernus.
local function contactIds()
    local m = getElementMatrix(veh)
    if not m then return "", "", "", "", 0 end
    local px, py, pz = m[4][1], m[4][2], m[4][3]
    local rxv, ryv, rzv = m[1][1], m[1][2], m[1][3]
    local fxv, fyv, fzv = m[2][1], m[2][2], m[2][3]
    local uxv, uyv, uzv = m[3][1], m[3][2], m[3][3]

    local function idAt(lx, ly)
        local sx = px + rxv * lx + fxv * ly + uxv * 0.35
        local sy = py + ryv * lx + fyv * ly + uyv * 0.35
        local sz = pz + rzv * lx + fzv * ly + uzv * 0.35
        -- rayo hacia el piso del loop: -up del vehiculo (no -Z del mundo)
        local hit, _, _, _, elem = processLineOfSight(
            sx, sy, sz,
            sx - uxv * 3.0, sy - uyv * 3.0, sz - uzv * 3.0,
            -- buildings, vehicles, players, objects, dummies,
            -- seeThrough, ignoreSome, shootThrough, ignoredElement
            true, false, false, true, false, false, false, false, veh)
        if hit and isElement(elem) and getElementType(elem) == "object" then
            return getElementID(elem) or "", num(getElementModel(elem), 0), elem
        end
        return "", 0, nil
    end

    local oc, model, ocelem = idAt(0, 0)
    local o1 = idAt(-0.85, -1.35)
    local o2 = idAt(0.85, -1.35)
    local o3 = idAt(-0.85, 1.35)
    local o4 = idAt(0.85, 1.35)
    return oc, o1, o2, o3, o4, model, ocelem
end

-- bbox local del objeto bajo el centro (se graba en cada muestra)
local function bboxOf(elem)
    if not isElement(elem) then return 0, 0, 0, 0, 0, 0 end
    local a, b, c, d, e, f = getElementBoundingBox(elem)
    return num(a, 0), num(b, 0), num(c, 0), num(d, 0), num(e, 0), num(f, 0)
end

local function capture()
    local x, y, z = getElementPosition(veh)
    local rx, ry, rz = getElementRotation(veh)
    local vx, vy, vz = getElementVelocity(veh)
    x, y, z = num(x, 0), num(y, 0), num(z, 0)
    rx, ry, rz = num(rx, 0), num(ry, 0), num(rz, 0)
    vx, vy, vz = num(vx, 0), num(vy, 0), num(vz, 0)
    local speed = math.sqrt(vx * vx + vy * vy + vz * vz) * 180.0

    local w1, w2, w3, w4 = getVehicleWheelStates(veh)
    local onground = 0
    if num(w1, 1) == 0 then onground = onground + 1 end
    if num(w2, 1) == 0 then onground = onground + 1 end
    if num(w3, 1) == 0 then onground = onground + 1 end
    if num(w4, 1) == 0 then onground = onground + 1 end

    local thr = num(getAnalogControlState("accelerate"), 0)
    local brk = num(getAnalogControlState("brake_reverse"), 0)
    local left = num(getAnalogControlState("vehicle_left"), 0)
    local right = num(getAnalogControlState("vehicle_right"), 0)
    local str = right - left
    local hb = getControlState("handbrake") and 1 or 0
    local nit = 0
    if isVehicleNitroActivated then
        nit = isVehicleNitroActivated(veh) and 1 or 0
    elseif getVehicleNitroActivated then
        nit = getVehicleNitroActivated(veh) and 1 or 0
    end
    local nitl = 0
    if getVehicleNitroLevel then
        nitl = num(getVehicleNitroLevel(veh), 0)
    end
    local nitc = 0
    if getVehicleNitroCount then
        nitc = num(getVehicleNitroCount(veh), 0)
    end
    local vehmodel = num(getElementModel(veh), 0)
    -- tecla de nitro (por si el mapa la bindea aparte)
    local nitk = 0
    if getControlState and getControlState("vehicle_nitro") then nitk = 1 end
    -- flechas: en el aire giran el coche (mecanica clasica de DM)
    local air = 0
    if getControlState("vehicle_left") then air = air + 1 end
    if getControlState("vehicle_right") then air = air + 2 end
    if getControlState("vehicle_forward") then air = air + 4 end
    if getControlState("vehicle_backward") then air = air + 8 end
    local gear = 0
    if getVehicleCurrentGear then
        gear = num(getVehicleCurrentGear(veh), 0)
    end
    local hp = num(getElementHealth(veh), 0)
    local php = num(getElementHealth(localPlayer), 0)
    local t = num(getTickCount() - t0, 0)
    local oc, o1, o2, o3, o4, om, ocelem = contactIds()
    local bx1, by1, bz1, bx2, by2, bz2 = bboxOf(ocelem)
    local ox, oy, oz, orx, ory, orz = 0, 0, 0, 0, 0, 0
    if isElement(ocelem) then
        local a, b, c = getElementPosition(ocelem)
        local d, e, f = getElementRotation(ocelem)
        ox, oy, oz = num(a, 0), num(b, 0), num(c, 0)
        orx, ory, orz = num(d, 0), num(e, 0), num(f, 0)
    end

    return string.format(
        '{"t":%d,"x":%.2f,"y":%.2f,"z":%.2f,"rx":%.1f,"ry":%.1f,"rz":%.1f,' ..
        '"vx":%.3f,"vy":%.3f,"vz":%.3f,"s":%.1f,"w":%d,"h":%.0f,"ph":%.0f,' ..
        '"thr":%.2f,"brk":%.2f,"str":%.2f,"hb":%d,"nit":%d,"nitc":%d,"nitl":%.3f,"nitk":%d,"veh":%d,"air":%d,"gear":%d,' ..
        '"oc":"%s","o1":"%s","o2":"%s","o3":"%s","o4":"%s","om":%d,' ..
        '"bx1":%.2f,"by1":%.2f,"bz1":%.2f,"bx2":%.2f,"by2":%.2f,"bz2":%.2f,' ..
        '"ox":%.2f,"oy":%.2f,"oz":%.2f,"orx":%.1f,"ory":%.1f,"orz":%.1f}',
        t, x, y, z, rx, ry, rz, vx, vy, vz, speed, onground, hp, php,
        thr, brk, str, hb, nit, nitc, nitl, nitk, vehmodel, air, gear,
        jesc(oc), jesc(o1), jesc(o2), jesc(o3), jesc(o4), om,
        bx1, by1, bz1, bx2, by2, bz2,
        ox, oy, oz, orx, ory, orz)
end

local function stopTimer()
    if timer then
        killTimer(timer)
        timer = nil
    end
end

local function sample()
    if not recording then return end
    if not isElement(veh) then
        out("vehiculo destruido; guardando")
        flush()
        triggerServerEvent("tel:stop", resourceRoot, "vehicle_gone")
        recording = false
        stopTimer()
        return
    end

    local ok, line = pcall(capture)
    if not ok then
        out("error al muestrear: " .. tostring(line))
        flush()
        triggerServerEvent("tel:stop", resourceRoot, "sample_error")
        recording = false
        stopTimer()
        return
    end

    count = count + 1
    buffer[#buffer + 1] = line
    if #buffer >= CHUNK then flush() end
end

local function beginSampling(msg)
    pending = false
    recording = true
    count = 0
    t0 = getTickCount()
    stopTimer()
    timer = setTimer(sample, 50, 0)
    out(msg or "REC 20Hz | /tx")
end

local function startRecording(label)
    if recording or pending then
        out("ya graba | /tx")
        return
    end
    local v = getPedOccupiedVehicle(localPlayer)
    if not v then
        out("subite a un vehiculo primero.")
        return
    end
    veh = v
    pending = true
    count = 0
    buffer = {}
    triggerServerEvent("tel:start", resourceRoot, label or "", getElementModel(v))
    out("PREP")

    -- si el servidor no confirma en 1 s, arrancamos igual: el servidor ya creo
    -- el archivo en tel:start, y si no, guarda los chunks en memoria
    setTimer(function()
        if pending then
            beginSampling("grabando (sin confirmacion del servidor; igual se envian datos).")
        end
    end, 1000, 1)
end

local function stopRecording(reason)
    stopTimer()
    if warpResume then killTimer(warpResume); warpResume = nil end
    pausedWarp = false
    if recording then flush() end
    if recording or pending then
        triggerServerEvent("tel:stop", resourceRoot, reason or "manual")
    end
    recording = false
    pending = false
    veh = nil
    out(string.format("OK %d", count))
end

addEvent("tel:ready", true)
addEventHandler("tel:ready", resourceRoot, function()
    if not pending then return end
    beginSampling("REC 20Hz | /tx")
end)

local function cmdStart(...)
    startRecording(table.concat({ ... }, " "))
end

local function cmdStop()
    stopRecording("manual")
end

local function cmdStatus()
    if recording then
        out(string.format("REC %d | %.0fs", count, (getTickCount() - t0) / 1000.0))
    elseif pending then
        out("PREP")
    else
        out("OFF | /ts")
    end
end

local function cmdBox()
    local v = getPedOccupiedVehicle(localPlayer)
    if not v then out("sin vehiculo") return end
    local m = getElementMatrix(v)
    if not m then out("sin matrix") return end
    local px, py, pz = m[4][1], m[4][2], m[4][3]
    local ux, uy, uz = m[3][1], m[3][2], m[3][3]
    local hit, _, _, _, elem = processLineOfSight(
        px + ux * 0.35, py + uy * 0.35, pz + uz * 0.35,
        px - ux * 3.0, py - uy * 3.0, pz - uz * 3.0,
        true, false, false, true, false, false, false, false, v)
    if not hit or not isElement(elem) then out("sin objeto") return end
    local a, b, c, d, e, f = getElementBoundingBox(elem)
    out(string.format("%s %d | %.2f %.2f %.2f | %.2f %.2f %.2f / %.2f %.2f %.2f",
        getElementID(elem) or "?", getElementModel(elem),
        getElementPosition(elem), a, b, c, d, e, f))
end

-- vuelca el bbox de TODOS los modelos del mapa cargado (para armar la tabla)
local function cmdBoxAll()
    local seen = {}
    local lines = {}
    for _, o in ipairs(getElementsByType("object")) do
        local m = getElementModel(o)
        if m and m ~= 0 and not seen[m] then
            seen[m] = true
            local a, b, c, d, e, f = getElementBoundingBox(o)
            a, b, c = num(a, 0), num(b, 0), num(c, 0)
            d, e, f = num(d, 0), num(e, 0), num(f, 0)
            lines[#lines + 1] = string.format(
                "m%d: %.2f x %.2f x %.2f | minZ %.2f maxZ %.2f",
                m, d - a, e - b, f - c, c, f)
        end
    end
    if #lines == 0 then
        out("sin objetos")
        return
    end
    for _, l in ipairs(lines) do out(l) end
end

addCommandHandler("telstart", cmdStart)
addCommandHandler("ts", cmdStart)
addCommandHandler("telstop", cmdStop)
addCommandHandler("tx", cmdStop)
addCommandHandler("telstatus", cmdStatus)
addCommandHandler("t?", cmdStatus)
addCommandHandler("tbox", cmdBox)
addCommandHandler("tboxall", cmdBoxAll)
addCommandHandler("tba", cmdBoxAll)

-- ---------------- warps: 1 guardar, 2 cargar + rebobinar, 3 eliminar ----------------
local warps = {}

-- warps persistentes: sobreviven al cambio de mapa / restart del resource
addEvent("tel:warpsLoaded", true)
addEventHandler("tel:warpsLoaded", resourceRoot, function(list)
    if type(list) == "table" then
        -- compatibilidad: si el archivo quedo envuelto [[...]], desenvolver
        if type(list[1]) == "table" and list[1].x == nil then
            list = list[1]
        end
        warps = {}
        for _, w in ipairs(list) do
            if type(w) == "table" and w.x and w.y and w.z then
                warps[#warps + 1] = w
            end
        end
        wout(string.format("warps restaurados: %d", #warps))
    end
end)
-- los warps son de la sesion: no sobreviven al restart del resource
addEventHandler("onClientResourceStart", resourceRoot, function()
    warps = {}
end)

-- el server avisa cuando cambia el mapa; un warp de otro mapa no sirve
addEvent("tel:resetWarps", true)
addEventHandler("tel:resetWarps", resourceRoot, function()
    warps = {}
    wout("warps limpiados (cambio de mapa)")
end)

local function wout(msg)
    out("[warp] " .. msg)
end

local function warpVehicle()
    return veh or getPedOccupiedVehicle(localPlayer)
end

local function saveWarp()
    local ok, err = pcall(function()
        local v = warpVehicle()
        if not v then wout("subite a un vehiculo") return end
        local x, y, z = getElementPosition(v)
        local rx, ry, rz = getElementRotation(v)
        local vx, vy, vz = getElementVelocity(v)
        if #warps >= 50 then table.remove(warps, 1) end
        table.insert(warps, {
            x = x, y = y, z = z, rx = rx, ry = ry, rz = rz,
            vx = vx, vy = vy, vz = vz,
            hp = num(getElementHealth(v), 1000),
            php = num(getElementHealth(localPlayer), 100),
            nit = (getVehicleNitroCount and num(getVehicleNitroCount(v), 0)) or 0,
            nitl = (getVehicleNitroLevel and num(getVehicleNitroLevel(v), 0)) or 0,
            nita = (isVehicleNitroActivated and isVehicleNitroActivated(v)) and 1 or 0,
            model = num(getElementModel(v), 0),
            count = count,
            t = num(getTickCount() - t0, 0),
        })
        wout(string.format("guardado #%d (muestra %d)", #warps, count))
        triggerServerEvent("tel:saveWarps", resourceRoot, warps)
    end)
    if not ok then wout("ERROR al guardar: " .. tostring(err)) end
end

local function loadWarp()
    local w = warps[#warps]
    if not w then wout("no hay warps (1 guarda)") return end
    local v = warpVehicle()
    if not v then wout("subite a un vehiculo") return end

    -- pausar muestreo mientras se teletransporta
    stopTimer()
    local ok, err = pcall(function()
        -- restaurar el AUTO del momento del warp (Sandking/Infernus/Hunter)
        if w.model and w.model > 0 and setElementModel and getElementModel(v) ~= w.model then
            pcall(setElementModel, v, w.model)
        end
        setElementPosition(v, w.x, w.y, w.z)
        setElementRotation(v, w.rx, w.ry, w.rz)
        setElementVelocity(v, w.vx, w.vy, w.vz)
        setElementHealth(v, w.hp)
        pcall(setElementHealth, localPlayer, w.php)
        -- nitro: estado EXACTO del warp (incluye "sin nitro": count 0)
        if setVehicleNitroCount then
            pcall(setVehicleNitroCount, v, math.max(0, num(w.nit, 0)))
        end
        if w.nitl and setVehicleNitroLevel then
            pcall(setVehicleNitroLevel, v, w.nitl)
        end
        if setVehicleNitroActivated then
            pcall(setVehicleNitroActivated, v, (w.nita or 0) == 1)
        end
    end)
    if not ok then
        wout("ERROR al cargar: " .. tostring(err))
        if recording then timer = setTimer(sample, 50, 0) end
        return
    end

    -- rebobinar la grabacion hasta la muestra del warp (el warp NO se borra)
    if recording then
        local drop = math.max(0, count - w.count)
        drop = math.min(drop, #buffer)
        for _ = 1, drop do buffer[#buffer] = nil end
        count = w.count
        triggerServerEvent("tel:truncate", resourceRoot, w.count)
        -- MARCADOR de warp: el analisis excluye solo este instante (las uniones del resto se analizan)
        buffer[#buffer + 1] = string.format(
            '{"type":"warp","t":%d,"n":%d,"x":%.2f,"y":%.2f,"z":%.2f}',
            w.t, w.count, w.x, w.y, w.z)
        -- esperar 0.5 s antes de reanudar y continuar el tiempo desde el warp
        pausedWarp = true
        if warpResume then killTimer(warpResume) end
        warpResume = setTimer(function()
            warpResume = nil
            pausedWarp = false
            if recording and isElement(v) then
                t0 = getTickCount() - w.t
                timer = setTimer(sample, 50, 0)
            end
        end, 500, 1)
    end
    wout(string.format("cargado (muestra %d) | %d warps", w.count, #warps))
end

local function delWarp()
    local w = table.remove(warps)
    if w then
        wout(string.format("eliminado | %d restantes", #warps))
        triggerServerEvent("tel:saveWarps", resourceRoot, warps)
    else
        wout("no hay warps")
    end
end

local function warpStatus()
    wout(string.format("%d warps", #warps))
end

bindKey("1", "down", saveWarp)
bindKey("2", "down", loadWarp)
bindKey("3", "down", delWarp)
bindKey("num_1", "down", saveWarp)
bindKey("num_2", "down", loadWarp)
bindKey("num_3", "down", delWarp)
addCommandHandler("wsa", saveWarp)
addCommandHandler("wld", loadWarp)
addCommandHandler("wdl", delWarp)
addCommandHandler("wstatus", warpStatus)

local toggleBusy = false
local function toggleRecording()
    if toggleBusy then return end
    toggleBusy = true
    if recording or pending then
        stopRecording("key")
        out("REC detenido")
    else
        startRecording("key")
        out("REC iniciando...")
    end
    toggleBusy = false
end

-- F7 (o numpad +) es la tecla principal: una sola tecla, siempre alterna.
-- E+K es el combo pedido (en race DM siempre vas en el coche, E maneja cámara).
local function comboRecording()
    if getKeyState("e") and getKeyState("k") then
        toggleRecording()
    end
end
bindKey("f7", "down", toggleRecording)
bindKey("num_add", "down", toggleRecording)
bindKey("e", "down", comboRecording)
bindKey("k", "down", comboRecording)

addEventHandler("onClientResourceStart", resourceRoot, function()
    out("tel | /ts [tag] | /tx | F7 o E+K graba/para | /t? | /tba | warp 1/2/3")
end)

-- si el jugador muere, cortar y guardar automaticamente
addEventHandler("onClientPlayerWasted", localPlayer, function()
    if recording or pending then
        stopRecording("muerte")
        out("REC detenido (muerte)")
    end
end)

-- HUD: REC + tiempo + muestras mientras graba
addEventHandler("onClientRender", root, function()
    if not recording and not pending then return end
    local secs = 0
    if recording then secs = math.floor((getTickCount() - t0) / 1000) end
    local label
    if pending then
        label = "PREP"
    elseif pausedWarp then
        label = "PAUSE"
    else
        label = string.format("REC %02d:%02d", math.floor(secs / 60), secs % 60)
    end
    dxDrawRectangle(18, 18, 205, 32, 0, 0, 0, 165)
    dxDrawRectangle(26, 30, 9, 9, 255, pausedWarp and 210 or (pending and 180 or 40), 40, 255)
    dxDrawText(label, 42, 21, 220, 45, tocolor(255, 255, 255, 255),
               1.0, "default-bold", "left", "top")
    dxDrawText(count .. " muestras", 130, 24, 220, 45, tocolor(180, 190, 205, 255),
               0.85, "default", "left", "top")
end)

addEventHandler("onClientResourceStop", resourceRoot, function()
    stopTimer()
    if warpResume then killTimer(warpResume); warpResume = nil end
    pausedWarp = false
    if recording then flush() end
end)
