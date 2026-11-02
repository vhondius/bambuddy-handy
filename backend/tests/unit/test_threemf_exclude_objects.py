"""Leaving objects out of a project 3MF before slicing."""

import io
import zipfile

import pytest

from backend.app.utils.threemf_tools import exclude_objects, list_plate_objects

MODEL = """<model><build>
  <item objectid="2" transform="1" printable="1"/>
  <item objectid="4" transform="2" printable="1"/>
  <item objectid="6" transform="3" printable="1"/>
  <item objectid="8" transform="4" printable="1"/>
 </build></model>"""


def _instance(object_id):
    return (
        f'<model_instance><metadata key="object_id" value="{object_id}"/>'
        f'<metadata key="instance_id" value="0"/></model_instance>'
    )


SETTINGS = f"""<config>
  <object id="2"><metadata key="name" value="Benchy"/></object>
  <object id="4"><metadata key="name" value="Benchy"/></object>
  <object id="6"><metadata key="name" value="Cube"/></object>
  <object id="8"><metadata key="name" value="Lid"/></object>
  <plate><metadata key="plater_id" value="1"/>{_instance(2)}{_instance(4)}{_instance(6)}</plate>
  <plate><metadata key="plater_id" value="2"/>{_instance(8)}</plate>
  <assemble>
   <assemble_item object_id="2" instance_id="0" transform="1"/>
   <assemble_item object_id="4" instance_id="0" transform="2"/>
  </assemble>
</config>"""


def _project():
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as zf:
        zf.writestr("3D/3dmodel.model", MODEL)
        zf.writestr("Metadata/model_settings.config", SETTINGS)
        zf.writestr("Metadata/project_settings.config", '{"keep": "me"}')
        zf.writestr("Metadata/plate_1.png", b"one")
        zf.writestr("Metadata/plate_2.png", b"two")
    return out.getvalue()


def _read(data, name):
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        return zf.read(name)


def test_lists_every_copy_per_plate():
    assert list_plate_objects(_project()) == [
        {"plate": 1, "object_id": "2", "instance_id": "0", "name": "Benchy"},
        {"plate": 1, "object_id": "4", "instance_id": "0", "name": "Benchy"},
        {"plate": 1, "object_id": "6", "instance_id": "0", "name": "Cube"},
        {"plate": 2, "object_id": "8", "instance_id": "0", "name": "Lid"},
    ]
    assert list_plate_objects(b"not a zip") == []


def test_excluded_copy_is_gone_and_the_rest_stays():
    out = exclude_objects(_project(), ["4:0"])
    model = _read(out, "3D/3dmodel.model").decode()
    settings = _read(out, "Metadata/model_settings.config").decode()
    assert 'objectid="4"' not in model
    assert all(f'objectid="{i}"' in model for i in (2, 6, 8))
    assert [(o["object_id"], o["plate"]) for o in list_plate_objects(out)] == [("2", 1), ("6", 1), ("8", 2)]
    assert 'assemble_item object_id="4"' not in settings
    assert 'assemble_item object_id="2"' in settings
    assert settings.count("<plate>") == 2
    assert _read(out, "Metadata/project_settings.config") == b'{"keep": "me"}'


def test_only_the_affected_plates_pictures_go():
    with zipfile.ZipFile(io.BytesIO(exclude_objects(_project(), ["6:0"]))) as zf:
        names = zf.namelist()
    assert "Metadata/plate_1.png" not in names
    assert "Metadata/plate_2.png" in names


def test_copies_sharing_an_object_id_go_in_instance_order():
    project = io.BytesIO()
    with zipfile.ZipFile(project, "w") as zf:
        zf.writestr(
            "3D/3dmodel.model",
            '<model><build><item objectid="2" transform="first"/><item objectid="2" transform="second"/></build></model>',
        )
        zf.writestr(
            "Metadata/model_settings.config",
            '<config><plate><metadata key="plater_id" value="1"/>'
            '<model_instance><metadata key="object_id" value="2"/><metadata key="instance_id" value="0"/></model_instance>'
            '<model_instance><metadata key="object_id" value="2"/><metadata key="instance_id" value="1"/></model_instance>'
            "</plate></config>",
        )
    model = _read(exclude_objects(project.getvalue(), ["2:1"]), "3D/3dmodel.model").decode()
    assert "first" in model
    assert "second" not in model


def test_nothing_excluded_returns_the_same_bytes():
    project = _project()
    assert exclude_objects(project, []) is project


@pytest.mark.parametrize(
    ("excluded", "message"),
    [
        (["99:0"], "No such object"),
        (["../evil"], "No such object"),
        (["8:0"], "Plate 2 needs at least one object"),
        (["2:0", "4:0", "6:0"], "Plate 1 needs at least one object"),
    ],
)
def test_refuses_what_it_should(excluded, message):
    with pytest.raises(ValueError, match=message):
        exclude_objects(_project(), excluded)
