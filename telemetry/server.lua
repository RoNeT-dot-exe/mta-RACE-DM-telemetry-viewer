-- telemetry: recibe chunks del cliente y escribe un JSONL por jugador.
-- El archivo queda en la carpeta del resource (mods/deathmatch/resources/telemetry/).

local files = {}
local bytes = {}
local pendingChunks = {}
local fname = {}

local function safeName(player)
    return (getPlayerName(player) or "player"):gsub("[^%w_%-]", "_")
end

local function esc(s)
    s = tostring(s or "")
    s = s:gsub("\\", "\\\\")
    s = s:gsub('"', '\\"')
    s = s:gsub("\n", "\\n")
    s = s:gsub("\r", "\\r")
    return s
end

local function closeFile(player)
    local f = files[player]
    if f then
        fileClose(f)
        files[player] = nil
    end
end

addEvent("tel:start", true)
addEventHandler("tel:start", resourceRoot, function(label, model)
    local player = client
    if not player then return end

    closeFile(player)
    bytes[player] = 0
    pendingChunks[player] = nil

    -- tag del mapa (tambien en el nombre del archivo)
    local mapName = ""
    local mapTitle = ""
    if getRunningGamemodeMap then
        local m = getRunningGamemodeMap()
        if m and isElement(m) then
            mapName = getResourceName(m) or ""
            if getResourceInfo then
                mapTitle = getResourceInfo(m, "name") or ""
            end
        end
    end
    -- fallback: usar el ultimo mapa que inicio el gamemode
    if mapName == "" then
        mapName = lastMapName or ""
        mapTitle = lastMapTitle or ""
    end
    local mapTag = mapName ~= "" and mapName:gsub("[^%w_%-]", "_") or ""
    mapTag = mapTag:sub(1, 40)

    local stamp = os.date("%Y%m%d_%H%M%S")
    -- carpeta por mapa: telemetry/<MAPATAG>/tel_<jugador>_<fecha>.jsonl
    local fpath = (mapTag ~= "" and (mapTag .. "/") or "")
                  .. "tel_" .. safeName(player) .. "_" .. stamp .. ".jsonl"
    local f = fileCreate(fpath)
    if not f and mapTag ~= "" then
        -- si no se pudo crear la carpeta, guardar plano con el tag en el nombre
        fpath = "tel_" .. safeName(player) .. "_" .. mapTag .. "_" .. stamp .. ".jsonl"
        f = fileCreate(fpath)
    end
    if not f then
        outputChatBox("#FF6666[telemetry]#FFFFFF no se pudo crear " .. fpath, player, 255, 255, 255, true)
        return
    end
    files[player] = f
    fname[player] = fpath

    local ver = getVersion()
    local verstr = type(ver) == "table" and (ver.sortable or ver.mta or "") or tostring(ver)
    local meta = string.format(
        '{"type":"meta","v":1,"player":"%s","vehicle":%d,"label":"%s","map":"%s","title":"%s","mta":"%s","date":"%s"}',
        esc(getPlayerName(player)), tonumber(model) or 0, esc(label), esc(mapName), esc(mapTitle),
        esc(verstr), os.date("%Y-%m-%d %H:%M:%S"))
    fileWrite(f, meta .. "\n")

    if pendingChunks[player] then
        fileWrite(f, pendingChunks[player])
        pendingChunks[player] = nil
    end

    triggerClientEvent(player, "tel:ready", resourceRoot)
    outputChatBox("#00C8FF[telemetry]#FFFFFF grabando en " .. fpath, player, 255, 255, 255, true)
end)

addEvent("tel:chunk", true)
addEventHandler("tel:chunk", resourceRoot, function(payload)
    if type(payload) ~= "string" or #payload == 0 then return end
    local f = files[client]
    if f then
        fileWrite(f, payload .. "\n")
        bytes[client] = (bytes[client] or 0) + #payload
    else
        -- llego antes de que el servidor creara el archivo: guardar en memoria
        pendingChunks[client] = (pendingChunks[client] or "") .. payload .. "\n"
    end
end)

addEvent("tel:stop", true)
addEventHandler("tel:stop", resourceRoot, function()
    local player = client
    if not player then return end
    local n = bytes[player] or 0
    closeFile(player)
    bytes[player] = nil
    pendingChunks[player] = nil
    outputChatBox("#00FF88[telemetry]#FFFFFF archivo guardado en resources/telemetry/ (" ..
                  n .. " bytes)", player, 255, 255, 255, true)
end)

-- rebobina el archivo: conserva la cabecera + las primeras `target` muestras
addEvent("tel:truncate", true)
addEventHandler("tel:truncate", resourceRoot, function(target)
    local player = client
    if not player then return end
    local name = fname[player]
    closeFile(player)
    if not name then return end

    local content = ""
    if fileExists(name) then
        local rf = fileOpen(name, true)
        if rf then
            local sz = fileGetSize(rf) or 0
            content = fileRead(rf, sz) or ""
            fileClose(rf)
        end
    end

    local lines = {}
    for l in content:gmatch("[^\r\n]+") do
        lines[#lines + 1] = l
    end

    local keep = {}
    if lines[1] then keep[#keep + 1] = lines[1] end
    local want = tonumber(target) or 0
    for i = 2, math.min(#lines, 1 + want) do
        keep[#keep + 1] = lines[i]
    end

    -- borrar el archivo viejo y recrearlo con lo que se conserva
    if fileExists(name) then
        local del = fileOpen(name)
        if del then fileDelete(del) end
    end
    local nf = fileCreate(name)
    if not nf then
        outputServerLog("[telemetry] no se pudo recrear " .. name .. " tras el warp")
        outputChatBox("#FF6666[telemetry]#FFFFFF no se pudo rebobinar el archivo", player, 255, 255, 255, true)
        return
    end
    local out = table.concat(keep, "\n") .. "\n"
    fileWrite(nf, out)
    files[player] = nf
    bytes[player] = #out
end)

addEventHandler("onPlayerQuit", root, function()
    closeFile(source)
    bytes[source] = nil
    pendingChunks[source] = nil
    fname[source] = nil
end)

addEventHandler("onResourceStart", resourceRoot, function()
    outputServerLog("[telemetry] resource iniciado. En el juego: /telstart [etiqueta]")
    if getRunningGamemodeMap then
        local m = getRunningGamemodeMap()
        if m and isElement(m) then
            lastMapName = getResourceName(m) or ""
            if getResourceInfo then
                lastMapTitle = getResourceInfo(m, "name") or ""
            end
        end
    end
end)

addEventHandler("onResourceStop", resourceRoot, function()
    for player in pairs(files) do
        closeFile(player)
    end
    files = {}
    bytes = {}
    pendingChunks = {}
    fname = {}
end)

-- ---------------- warps persistentes (por jugador) ----------------
local warpStore = {}
local function warpPath(player)
    return "warps_" .. safeName(player) .. ".json"
end

-- ultimo mapa iniciado por el gamemode (fallback si getRunningGamemodeMap falla)
lastMapName, lastMapTitle = "", ""
addEventHandler("onGamemodeMapStart", root, function(theMap)
    lastMapName = getResourceName(theMap) or ""
    if getResourceInfo then
        lastMapTitle = getResourceInfo(theMap, "name") or ""
    end
    -- al cambiar de mapa se limpian los warps de los jugadores
    triggerClientEvent("tel:resetWarps", root, resourceRoot)
end)

addEvent("tel:saveWarps", true)
addEventHandler("tel:saveWarps", resourceRoot, function(list)
    local player = client
    if not player or type(list) ~= "table" then return end
    -- sanear: solo warps validos, array plano (evita el [[...]] anidado)
    local clean = {}
    if type(list) == "table" then
        if type(list[1]) == "table" and list[1].x == nil then list = list[1] end
        for _, w in ipairs(list) do
            if type(w) == "table" and w.x then clean[#clean + 1] = w end
        end
    end
    list = clean
    warpStore[player] = list
    if toJSON then
        local ok, data = pcall(toJSON, list)
        if ok and data then
            local f = fileCreate(warpPath(player))
            if f then
                fileWrite(f, data)
                fileClose(f)
            end
        end
    end
end)

addEvent("tel:loadWarps", true)
addEventHandler("tel:loadWarps", resourceRoot, function()
    local player = client
    if not player then return end
    local list = warpStore[player]
    if not list and fromJSON and fileExists(warpPath(player)) then
        local f = fileOpen(warpPath(player))
        if f then
            local data = fileRead(f, fileGetSize(f))
            fileClose(f)
            local ok, parsed = pcall(fromJSON, data)
            if ok and type(parsed) == "table" then list = parsed end
        end
    end
    triggerClientEvent(player, "tel:warpsLoaded", resourceRoot, list or {})
end)

addEventHandler("onPlayerQuit", root, function()
    warpStore[source] = nil
end)

