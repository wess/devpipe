#
#  document.ex
#  providers
# 
#  Created by Wess Cope (me@wess.io) on 12/13/19
#  Copyright 2019 Wess Cope
#

defmodule Provider.Document do
  use Provider

  alias Data.Repo
  alias Model.Document, as: Model

  def create(params) do
    %Model{}
    |> Model.changeset(params)
    |> Repo.insert()
  end

  def delete(name: name) do
    Model
    |> Repo.get_by(name: name)
    |> Repo.delete!
  end

  def delete(id: id) do
    Model
    |> Repo.get_by(id: id)
    |> Repo.delete!
  end

  def delete(doc: doc) do
    doc
    |> Repo.delete!
  end

  def get_or_create(name: name) do
    case Model |> Repo.get_by(name: name) do
      nil -> 
        %Model{name: name}
      doc -> 
        doc
    end
    |> Repo.insert_or_update!

  end

  def get(id: id) do
    Model
    |> Repo.get(id)
  end

  def get(name: name) do
    Model
    |> Repo.get_by(name: name)
  end

  def all() do
    Model
    |> Repo.all
  end
end
