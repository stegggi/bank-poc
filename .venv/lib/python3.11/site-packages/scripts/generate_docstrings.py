import importlib
import inspect
from pydantic import BaseModel
import re

MODELS_MODULE = "ethereal.models.rest"
OUTPUT_FILE = "all_model_docs.txt"


def camel_to_snake(name: str) -> str:
    """
    Convert CamelCase or camelCase string to snake_case.
    Examples:
        >>> camel_to_snake('CamelCase')
        'camel_case'
        >>> camel_to_snake('camelCase')
        'camel_case'
    """
    # First, put an underscore between a lowercase-to-uppercase transition
    s1 = re.sub(r"(.)([A-Z][a-z]+)", r"\1_\2", name)
    # Next, handle transitions like lowercase-or-digit to uppercase
    s2 = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", s1)
    return s2.lower()


def model_to_doc(model: type[BaseModel]) -> str:
    """
    Render a single-model documentation block in “Args / Other Parameters” style.
    """
    schema = model.schema()
    title = model.__name__
    required_fields = set(schema.get("required", []))
    props = schema.get("properties", {})

    # split into required vs optional
    req_props = {k: v for k, v in props.items() if k in required_fields}
    opt_props = {k: v for k, v in props.items() if k not in required_fields}

    lines = [
        title,
        "=" * len(title),
        "",
        "Args:",
    ]
    for name, meta in req_props.items():
        typ = meta.get("type", "Any")
        desc = meta.get("description", "").rstrip(".")
        lines.append(f"    {camel_to_snake(name)} ({typ}): {desc}. Required.")
    lines += [
        "",
        "Other Parameters:",
    ]
    if opt_props:
        for name, meta in opt_props.items():
            typ = meta.get("type", "Any")
            desc = meta.get("description", "").rstrip(".")
            lines.append(
                f"    {camel_to_snake(name)} ({typ}, optional): {desc}. Optional."
            )
    lines.append(
        "    **kwargs: Additional request parameters accepted by the API. Optional."
    )
    lines.append("\n")
    return "\n".join(lines)


def main():
    mod = importlib.import_module(MODELS_MODULE)

    docs = []
    for name, obj in vars(mod).items():
        if inspect.isclass(obj) and issubclass(obj, BaseModel) and obj is not BaseModel:
            docs.append(model_to_doc(obj))

    with open(OUTPUT_FILE, "w") as f:
        f.write("\n".join(docs))

    print(f"Wrote docs for {len(docs)} models to {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
