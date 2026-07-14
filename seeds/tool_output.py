# /// script
# dependencies = [
#   "pydantic",
#   "dataclasses",
# ]
# ///

from pydantic import BaseModel

class Fruit(BaseModel):
  name: str
  color: str

class Vehicle(BaseModel):
  name: str
  wheels: int
