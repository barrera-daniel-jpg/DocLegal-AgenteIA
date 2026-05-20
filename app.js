// =============================================
// CONFIGURACIÓN
// =============================================

// CORRECCIÓN: el modelo correcto es qwen2.5:1.5b (no qwen2:1.5b)
// y la API correcta para instrucciones es /api/chat (no /api/generate)
const OLLAMA_BASE = 'http://localhost:11434';
const OLLAMA_URL = `${OLLAMA_BASE}/api/chat`;
const MODELO = 'qwen2.5:1.5b';

// Variables globales
let archivos = [];
let resultados = [];

// Configura pdf.js para leer PDFs
pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';


// =============================================
// VERIFICAR QUE OLLAMA ESTÁ CORRIENDO
// =============================================

async function verificarOllama() {
    const badge = document.getElementById('statusBadge');
    try {
        const res = await fetch(`${OLLAMA_BASE}/api/tags`);
        if (!res.ok) throw new Error('no ok');

        const datos = await res.json();
        // Verificar si el modelo específico está descargado
        const modelos = (datos.models || []).map(m => m.name);
        const tieneModelo = modelos.some(m => m.startsWith('qwen2.5:1.5b'));

        if (tieneModelo) {
            badge.textContent = `✓ ${MODELO} listo`;
            badge.classList.add('listo');
        } else {
            badge.textContent = `⚠ Ollama activo pero falta el modelo`;
            badge.classList.add('advertencia');
            // Mostrar instrucción al usuario
            console.warn(`Modelo no encontrado. Ejecuta en terminal:\n  ollama pull ${MODELO}`);
        }
    } catch {
        badge.textContent = '✗ Ollama no encontrado — ejecuta: ollama serve';
        badge.classList.add('error');
    }
}

verificarOllama();


// =============================================
// MANEJO DE ARCHIVOS
// =============================================

document.getElementById('inputArchivos').addEventListener('change', function () {
    agregarArchivos(this.files);
});

const zona = document.getElementById('zonaSubida');

zona.addEventListener('dragover', (e) => {
    e.preventDefault();
    zona.style.borderColor = 'var(--acento)';
});

zona.addEventListener('dragleave', () => {
    zona.style.borderColor = '';
});

zona.addEventListener('drop', (e) => {
    e.preventDefault();
    zona.style.borderColor = '';
    agregarArchivos(e.dataTransfer.files);
});

function agregarArchivos(nuevosArchivos) {
    for (const archivo of nuevosArchivos) {
        const yaExiste = archivos.find(a => a.archivo.name === archivo.name);
        if (!yaExiste) {
            archivos.push({
                archivo,
                estado: 'pendiente',
                id: Date.now() + Math.random()
            });
        }
    }
    renderizarListaArchivos();
}

function renderizarListaArchivos() {
    const contenedor = document.getElementById('listaArchivos');
    contenedor.innerHTML = '';

    archivos.forEach((item, indice) => {
        const esPDF = item.archivo.type === 'application/pdf';
        const icono = esPDF ? '📑' : '🖼️';
        const tamano = formatearTamano(item.archivo.size);

        contenedor.innerHTML += `
      <div class="archivo-item" id="archivo-${item.id}">
        <span>${icono}</span>
        <span class="archivo-nombre" title="${item.archivo.name}">${item.archivo.name}</span>
        <small style="color:var(--muted)">${tamano}</small>
        <span class="archivo-estado estado-${item.estado}" id="estado-${item.id}">
          ${etiquetaEstado(item.estado)}
        </span>
        <button onclick="eliminarArchivo(${indice})" style="padding:4px 8px;font-size:12px">✕</button>
      </div>
    `;
    });

    document.getElementById('btnClasificar').disabled = archivos.length === 0;
}

function etiquetaEstado(estado) {
    return {
        pendiente: 'Pendiente',
        procesando: '⏳ Procesando...',
        listo: '✓ Listo',
        error: '✗ Error'
    }[estado] || estado;
}

function eliminarArchivo(indice) {
    archivos.splice(indice, 1);
    renderizarListaArchivos();
}

function limpiarTodo() {
    archivos = [];
    resultados = [];
    renderizarListaArchivos();
    renderizarResultados();
}

function formatearTamano(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
}


// =============================================
// EXTRAER TEXTO DE DOCUMENTOS
// =============================================

async function extraerTextoPDF(archivo) {
    const buffer = await archivo.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;

    let textoCompleto = '';
    const paginas = Math.min(pdf.numPages, 5);

    for (let p = 1; p <= paginas; p++) {
        const pagina = await pdf.getPage(p);
        const contenido = await pagina.getTextContent();
        // Unir con espacio y limpiar espacios múltiples
        const textoPagina = contenido.items
            .map(i => i.str)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
        textoCompleto += textoPagina + '\n';
    }

    // 3000 caracteres es suficiente para qwen2.5:1.5b y evita context overflow
    return textoCompleto.substring(0, 3000);
}


// =============================================
// PROMPT Y COMUNICACIÓN CON OLLAMA
// =============================================

// CORRECCIÓN: prompt más compacto y explícito para modelos pequeños (1.5B).
// Los modelos pequeños se confunden con prompts largos o con demasiados ejemplos.
// Usar /api/chat con messages[] es más estable que /api/generate para instrucciones.

const INSTRUCCIONES = `Eres un extractor de datos de documentos colombianos.
Responde SOLO con JSON. Sin texto extra, sin markdown.

Tipos válidos (elige uno): Factura | RUT | DIAN | Judicial | Contrato | Otro
Estados válidos (elige uno): pagado | pendiente | vencido | desconocido
Confianza: número entre 0 y 1 según qué tan seguro estás.

JSON obligatorio:
{"tipo":"","emisor":null,"nit_emisor":null,"receptor":null,"nit_receptor":null,"numero_documento":null,"fecha":null,"monto":null,"estado":"desconocido","confianza":0.9,"resumen":""}

Reglas:
- fecha en formato YYYY-MM-DD o null
- monto como número sin símbolos o null  
- resumen máximo 15 palabras
- Si no encuentras un campo usa null`;

async function clasificarConOllama(texto, nombreArchivo) {
    const respuesta = await fetch(OLLAMA_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: MODELO,
            stream: false,
            format: 'json',          // Ollama fuerza salida JSON válida
            options: {
                temperature: 0,      // 0 = máxima determinismo, ideal para extracción
                num_predict: 250,    // suficiente para el JSON completo
                num_ctx: 2048        // contexto reducido para ahorrar RAM en 6 GB
            },
            messages: [
                {
                    role: 'system',
                    content: INSTRUCCIONES
                },
                {
                    role: 'user',
                    // CORRECCIÓN: el nombre del archivo como pista adicional ayuda
                    content: `Documento: "${nombreArchivo}"\n\n${texto}`
                }
            ]
        })
    });

    if (!respuesta.ok) {
        const err = await respuesta.text();
        throw new Error(`Ollama respondió ${respuesta.status}: ${err}`);
    }

    const datos = await respuesta.json();

    // /api/chat devuelve la respuesta en message.content (no en .response)
    const textoRespuesta = datos.message?.content?.trim();

    if (!textoRespuesta) {
        throw new Error('Respuesta vacía del modelo');
    }

    // Limpiar posibles bloques markdown que algunos modelos añaden
    const limpio = textoRespuesta
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/```\s*$/i, '')
        .trim();

    return JSON.parse(limpio);
}

// NUEVO: reintento automático si el JSON falla (común en modelos pequeños)
async function clasificarConReintentos(texto, nombreArchivo, intentos = 2) {
    let ultimoError;
    for (let i = 0; i < intentos; i++) {
        try {
            return await clasificarConOllama(texto, nombreArchivo);
        } catch (err) {
            ultimoError = err;
            console.warn(`Intento ${i + 1} fallido para ${nombreArchivo}:`, err.message);
            // Esperar 500ms antes de reintentar
            if (i < intentos - 1) await new Promise(r => setTimeout(r, 500));
        }
    }
    throw ultimoError;
}


// =============================================
// PROCESO PRINCIPAL DE CLASIFICACIÓN
// =============================================

async function clasificarTodo() {
    const pendientes = archivos.filter(a => a.estado === 'pendiente');

    if (pendientes.length === 0) {
        alert('No hay documentos pendientes de clasificar');
        return;
    }

    document.getElementById('barraWrap').style.display = 'block';
    document.getElementById('btnClasificar').disabled = true;

    let procesados = 0;

    for (const item of pendientes) {
        item.estado = 'procesando';
        actualizarEstadoUI(item);

        try {
            let texto;

            if (item.archivo.type === 'application/pdf') {
                texto = await extraerTextoPDF(item.archivo);
            } else {
                // Para imágenes: usar nombre como pista de clasificación
                // qwen2.5:1.5b no soporta visión, pero el nombre suele dar contexto
                const ext = item.archivo.name.split('.').pop().toUpperCase();
                texto = `Archivo de imagen ${ext}: ${item.archivo.name}
Nota: documento escaneado sin texto extraíble. Clasificar por nombre de archivo.`;
            }

            // CORRECCIÓN: usar clasificarConReintentos en vez de clasificarConOllama directo
            const resultado = await clasificarConReintentos(texto, item.archivo.name);

            resultado._nombreArchivo = item.archivo.name;
            resultado._id = item.id;
            resultados.push(resultado);

            item.estado = 'listo';

        } catch (error) {
            console.error('Error procesando', item.archivo.name, error);
            item.estado = 'error';
            item.error = error.message;

            // NUEVO: guardar un resultado de error para que aparezca en la lista
            resultados.push({
                _nombreArchivo: item.archivo.name,
                _id: item.id,
                tipo: 'Otro',
                emisor: null,
                nit_emisor: null,
                fecha: null,
                monto: null,
                estado: 'desconocido',
                confianza: 0,
                resumen: `Error al procesar: ${error.message}`
            });
        }

        procesados++;
        const porcentaje = (procesados / pendientes.length) * 100;
        document.getElementById('barraFill').style.width = porcentaje + '%';

        actualizarEstadoUI(item);
        renderizarResultados();
    }

    setTimeout(() => {
        document.getElementById('barraWrap').style.display = 'none';
        document.getElementById('barraFill').style.width = '0%';
    }, 1500);

    document.getElementById('btnClasificar').disabled = false;
}

function actualizarEstadoUI(item) {
    const estadoEl = document.getElementById('estado-' + item.id);
    if (estadoEl) {
        estadoEl.className = 'archivo-estado estado-' + item.estado;
        estadoEl.textContent = etiquetaEstado(item.estado);
    }
}


// =============================================
// MOSTRAR RESULTADOS EN PANTALLA
// =============================================

function renderizarResultados() {
    const lista = document.getElementById('listaResultados');
    const vacio = document.getElementById('estadoVacio');
    const exportar = document.getElementById('seccionExportar');

    document.getElementById('contadorResultados').textContent = resultados.length;

    if (resultados.length === 0) {
        vacio.style.display = 'flex';
        lista.innerHTML = '';
        exportar.style.display = 'none';
        return;
    }

    vacio.style.display = 'none';
    exportar.style.display = 'flex';

    lista.innerHTML = resultados.map((r, i) => {
        // CORRECCIÓN: confianza ahora viene del modelo (0–1), mostrar correctamente
        const confianzaPct = Math.round((parseFloat(r.confianza) || 0) * 100);
        const colorConfianza = confianzaPct >= 80 ? 'var(--verde, #22c55e)'
            : confianzaPct >= 50 ? 'var(--amarillo, #eab308)'
                : 'var(--rojo, #ef4444)';

        return `
    <div class="resultado-card" id="rcard-${i}">
      <div class="resultado-header" onclick="toggleTarjeta(${i})">
        <span class="tipo-badge tipo-${r.tipo || 'Otro'}">${r.tipo || 'Otro'}</span>
        <span class="resultado-nombre">${r._nombreArchivo}</span>
        <span style="font-size:12px;color:${colorConfianza};margin-left:auto;margin-right:8px">
          ${confianzaPct}%
        </span>
        <span>⌄</span>
      </div>
      <div class="resultado-body">
        ${r.resumen ? `<p class="resumen-texto">${r.resumen}</p>` : ''}
        <div>
          ${filaDato('Emisor', r.emisor)}
          ${filaDato('NIT Emisor', r.nit_emisor)}
          ${filaDato('Receptor', r.receptor)}
          ${filaDato('NIT Receptor', r.nit_receptor)}
          ${filaDato('N° Documento', r.numero_documento)}
          ${filaDato('Fecha', r.fecha)}
          ${filaDato('Monto', r.monto, true)}
          ${filaDato('Estado', r.estado)}
        </div>
        <p style="font-size:12px;color:var(--muted);margin-top:12px">
          Confianza IA: <span style="color:${colorConfianza};font-weight:600">${confianzaPct}%</span>
        </p>
      </div>
    </div>
  `;
    }).join('');
}

function filaDato(clave, valor, esMonto = false) {
    if (valor === null || valor === undefined || valor === '' || valor === 'null') return '';
    const valorMostrar = esMonto
        ? '$' + Number(valor).toLocaleString('es-CO')
        : valor;
    return `
    <div class="dato-fila">
      <span class="dato-clave">${clave}</span>
      <span class="dato-valor ${esMonto ? 'dato-monto' : ''}">${valorMostrar}</span>
    </div>
  `;
}

function toggleTarjeta(i) {
    document.getElementById('rcard-' + i).classList.toggle('abierto');
}


// =============================================
// EXPORTAR RESULTADOS
// =============================================

function exportarCSV() {
    const columnas = ['Archivo', 'Tipo', 'Emisor', 'NIT Emisor',
        'Receptor', 'NIT Receptor', 'N° Documento', 'Fecha', 'Monto', 'Estado', 'Confianza %', 'Resumen'];

    const filas = resultados.map(r => [
        r._nombreArchivo, r.tipo, r.emisor, r.nit_emisor,
        r.receptor, r.nit_receptor, r.numero_documento, r.fecha,
        r.monto, r.estado,
        Math.round((parseFloat(r.confianza) || 0) * 100),
        r.resumen
    ].map(v => `"${(v ?? '').toString().replace(/"/g, '""')}"`));

    const csv = [columnas, ...filas].map(f => f.join(',')).join('\n');
    descargarArchivo('clasificacion.csv', csv, 'text/csv;charset=utf-8;');
}

function exportarJSON() {
    // Limpiar campos internos antes de exportar
    const limpio = resultados.map(({ _id, ...r }) => r);
    descargarArchivo('clasificacion.json', JSON.stringify(limpio, null, 2), 'application/json');
}

function descargarArchivo(nombre, contenido, tipo) {
    const enlace = document.createElement('a');
    enlace.href = URL.createObjectURL(new Blob([contenido], { type: tipo }));
    enlace.download = nombre;
    enlace.click();
    // Liberar memoria
    setTimeout(() => URL.revokeObjectURL(enlace.href), 1000);
}