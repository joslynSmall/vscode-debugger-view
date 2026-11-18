import json
import re
import sys
from pathlib import Path

import jedi

fixture = Path(sys.argv[1])
src = fixture / 'src'
project = jedi.Project(path=src, sys_path=[str(src), str(fixture / 'site-packages')])


def calls_of(file_name, function_name):
    source = (src / file_name).read_text()
    script = jedi.Script(source, path=src / file_name, project=project)
    functions = [
        name for name in script.get_names(all_scopes=True, definitions=True)
        if name.name == function_name and name.type == 'function' and name.line is not None
    ]
    if not functions:
        raise SystemExit(f'missing {function_name} in {file_name}')
    function = functions[0]
    function_line = function.line or 0
    next_line = min([item.line for item in functions if item.line is not None and item.line > function_line], default=10**9)
    seen = []
    for line_number, text in enumerate(source.splitlines(), start=1):
        if not (function_line < line_number < next_line):
            continue
        for match in re.finditer(r'\b([A-Za-z_]\w*)\s*\(', text):
            inferred = script.infer(line_number, match.start(1))
            target = next((item for item in inferred if item.type == 'function' and item.module_path), None)
            if not target:
                continue
            item = {'line': line_number, 'name': target.name, 'file': str(target.module_path)}
            if item not in seen:
                seen.append(item)
    return seen


print(json.dumps({
    'start': calls_of('flow.py', 'start'),
    'use_lib': calls_of('with_lib.py', 'use_lib'),
}))
