# /// script
# dependencies = [
#   "pydantic",
#   "dataclasses",
# ]
# ///

from pydantic import BaseModel, Field

class Fruit(BaseModel):
  name: str
  color: str

class Vehicle(BaseModel):
  name: str
  wheels: int

class WriteFileArgss(BaseModel):
  path: str = Field(description="The target file path")
  content: str = Field(description="The file body content")