const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const browseBtn = document.getElementById('browseBtn');
const roll = document.getElementById('roll');
const framesEl = document.getElementById('frames');
const frameCountEl = document.getElementById('frameCount');
const developBtn = document.getElementById('developBtn');
const statusEl = document.getElementById('status');
const linkList = document.getElementById('linkList');

let files = []; // { file, url }

browseBtn.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('click', (e) => {
  if (e.target === browseBtn) return;
  fileInput.click();
});

fileInput.addEventListener('change', (e) => addFiles(e.target.files));

['dragenter', 'dragover'].forEach(evt => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
});
['dragleave', 'drop'].forEach(evt => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
  });
});
dropzone.addEventListener('drop', (e) => {
  addFiles(e.dataTransfer.files);
});

function addFiles(fileList) {
  const incoming = Array.from(fileList).filter(f => f.type.startsWith('image/'));
  incoming.forEach(file => {
    files.push({ file, url: URL.createObjectURL(file) });
  });
  fileInput.value = '';
  render();
}

function removeFile(index) {
  URL.revokeObjectURL(files[index].url);
  files.splice(index, 1);
  render();
}

function render() {
  roll.style.display = files.length ? 'block' : 'none';
  frameCountEl.textContent = `${files.length} เฟรม`;
  framesEl.innerHTML = '';
  files.forEach((f, i) => {
    const div = document.createElement('div');
    div.className = 'frame';
    const num = String(i + 1).padStart(2, '0');
    div.innerHTML = `
      <img src="${f.url}" alt="${f.file.name}" />
      <span class="tag">${num}/${files.length}</span>
      <button class="remove" data-i="${i}" title="เอาออก">×</button>
    `;
    framesEl.appendChild(div);
  });
  framesEl.querySelectorAll('.remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeFile(Number(btn.dataset.i));
    });
  });
  developBtn.disabled = files.length === 0;
}

developBtn.addEventListener('click', async () => {
  if (!files.length) return;
  developBtn.disabled = true;
  statusEl.className = 'status';
  statusEl.textContent = `กำลังล้างฟิล์ม ${files.length} เฟรม...`;
  linkList.innerHTML = '';

  const formData = new FormData();
  files.forEach(f => formData.append('images', f.file, f.file.name));

  try {
    const res = await fetch('/convert-and-upload', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'ส่งไม่สำเร็จ');

    renderLinks(data.results);
    const okCount = data.results.filter(r => r.url).length;
    const failCount = data.results.length - okCount;
    statusEl.className = failCount ? 'status error' : 'status success';
    statusEl.textContent = failCount
      ? `ส่งสำเร็จ ${okCount} รูป, พลาด ${failCount} รูป (ดูรายละเอียดด้านล่าง)`
      : `ส่งสำเร็จครบ ${okCount} รูป — ลิงก์อยู่ด้านล่างนี้`;
  } catch (err) {
    statusEl.className = 'status error';
    statusEl.textContent = err.message;
  } finally {
    developBtn.disabled = files.length === 0;
  }
});

function renderLinks(results) {
  linkList.innerHTML = '';
  results.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'link-row' + (r.url ? '' : ' errored');
    const num = String(i + 1).padStart(2, '0');
    row.innerHTML = `
      <span class="tag">${num}</span>
      <input type="text" readonly value="${r.url ? r.url : 'พลาด: ' + r.error}" />
      ${r.url ? '<button class="copy">คัดลอก</button>' : ''}
    `;
    linkList.appendChild(row);
    const input = row.querySelector('input');
    const copyBtn = row.querySelector('.copy');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(input.value);
        copyBtn.textContent = 'คัดลอกแล้ว';
        setTimeout(() => (copyBtn.textContent = 'คัดลอก'), 1200);
      });
    }
  });

  const successUrls = results.filter(r => r.url).map(r => r.url);
  if (successUrls.length > 1) {
    const allBtn = document.createElement('button');
    allBtn.className = 'copy-all';
    allBtn.textContent = 'คัดลอกลิงก์ทั้งหมด (บรรทัดละลิงก์)';
    allBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(successUrls.join('\n'));
      allBtn.textContent = 'คัดลอกแล้ว';
      setTimeout(() => (allBtn.textContent = 'คัดลอกลิงก์ทั้งหมด (บรรทัดละลิงก์)'), 1200);
    });
    linkList.appendChild(allBtn);
  }
}
