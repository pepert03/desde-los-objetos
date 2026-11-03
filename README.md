# Desde los objetos

Visor 3D del Trabajo Fin de Grado *«Desde los objetos. Domesticidad mínima japonesa entre 2001-2024»* de Isabel Ridruejo Tuñón (ETSAM, UPM), presentado como un cuaderno A5 de tapa blanda con lomo encolado apoyado sobre una mesa, con hojas de papel cebolla en los casos de estudio (págs. 41–84).

## Ver en local

La web necesita un servidor (abrir `index.html` con doble clic no funciona):

```bash
python -m http.server 4817 --bind 127.0.0.1 --directory docs
```

y abrir <http://127.0.0.1:4817>.

La carpeta `docs/` es estática y se publica en GitHub Pages desde la rama `main` (carpeta `/docs`): <https://pepert03.github.io/desde-los-objetos/>

## Regenerar las imágenes de las páginas

Con el PDF del TFG en la raíz del proyecto:

```bash
python tools/render_pages.py        # docs/img/a  (resolución normal)
python tools/render_pages.py --hd   # docs/img/h  (alta resolución, para ampliar)
```
