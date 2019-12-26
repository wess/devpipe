#
#  provider.ex
#  lib
# 
#  Created by Wess Cope (me@wess.io) on 12/13/19
#  Copyright 2019 Wess Cope
#

defmodule Attachment.Provider do
  use Provider

  alias Data.Repo  

  def create(data) do
    %Attachment{}
    |> Attachment.changeset(data)
    |> Repo.insert()
  end

  def list(owner_id: owner_id) do
    Attachment
    |> where([a], a.owner_id == ^owner_id)
    |> Repo.all
  end

  def get(id: id) do
    Attachment
    |> Repo.get(id)
  end

  def get(name: name) do
    Attachment
    |> where([a], a.name == ^name) 
    |> Repo.all
  end

  def get(identifier: identifier) do
    Attachment
    |> where([a], a.name == ^identifier)
    |> or_where([a], a.id == ^identifier)
    |> Repo.all
  end

  def delete(id: id) do
    Model
    |> Repo.get(id)
    |> Repo.delete
  end

  def delete(attachment: attachment) do
    attachment
    |> Repo.delete!
  end

  def search(owner_id, nil) do
    list(owner_id: owner_id)
  end

  def search(owner_id, name_match) do
    param = "#{name_match}%"

    Attachment
    |> where([a], ilike(a.name, ^param))
    |> where([a], a.owner_id == ^owner_id)
    |> Repo.all
  end

  def search(like_name) do
    param = "#{like_name}"

    Attachment
    |> where([a], ilike(a.name, ^param))
    |> Repo.all
  end
end
